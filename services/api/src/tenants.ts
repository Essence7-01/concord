import { rmSync } from "node:fs";
import { join } from "node:path";
import { Concord, NotFound, type Networks } from "./concord.js";
import { Db } from "./db.js";
import { ORG_MIGRATIONS } from "./schema.js";

/** Where each workspace's database lives. */
export interface OrgStore {
  open(orgId: string): Db;
  remove(orgId: string): void;
}

export function fileStore(dataDir: string): OrgStore {
  const path = (orgId: string) => join(dataDir, "orgs", `${orgId}.db`);
  return {
    open: (orgId) => new Db(path(orgId), ORG_MIGRATIONS),
    remove: (orgId) => {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path(orgId)}${suffix}`, { force: true });
    },
  };
}

/** For tests: a workspace lives as long as its handle. */
export function memoryStore(): OrgStore {
  return { open: () => new Db(":memory:", ORG_MIGRATIONS), remove: () => {} };
}

const ORG_ID = /^[0-9a-f]{16}$/;

/**
 * Workspaces, one database file each. Nothing a workspace stores is reachable from another's
 * handle, so the routes cannot leak across tenants by forgetting a filter.
 */
export class Tenants {
  private readonly open = new Map<string, Concord>();

  constructor(
    private readonly store: OrgStore,
    private readonly networks: Networks,
    /** Only workspaces the identity records know are opened. */
    private readonly known: (orgId: string) => boolean,
    private readonly listOrgIds: () => string[],
  ) {}

  forOrg(orgId: string): Concord {
    // The id becomes part of a file name; refuse anything that is not one we generate.
    if (typeof orgId !== "string" || !ORG_ID.test(orgId)) throw new NotFound("no such workspace");
    const cached = this.open.get(orgId);
    if (cached) return cached;
    if (!this.known(orgId)) throw new NotFound("no such workspace");
    const db = this.store.open(orgId);
    const owner = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'org_id'");
    if (!owner) {
      db.run("INSERT INTO meta (key, value) VALUES ('org_id', ?)", orgId);
    } else if (owner.value !== orgId) {
      db.close();
      throw new Error(`the database for workspace ${orgId} belongs to ${owner.value}`);
    }
    const workspace = new Concord(db, this.networks);
    this.open.set(orgId, workspace);
    return workspace;
  }

  /** Close a workspace and delete its database. */
  drop(orgId: string): void {
    if (!ORG_ID.test(orgId)) return;
    const workspace = this.open.get(orgId);
    this.open.delete(orgId);
    workspace?.db.close();
    this.store.remove(orgId);
  }

  /** Index every asset of every workspace, then advance corporate actions that have come due. */
  async syncAll(): Promise<Array<{ orgId: string; assetId: string; added?: number; error?: string }>> {
    const out: Array<{ orgId: string; assetId: string; added?: number; error?: string }> = [];
    for (const orgId of this.listOrgIds()) {
      try {
        const workspace = this.forOrg(orgId);
        const results = await workspace.syncAll();
        for (const [assetId, r] of Object.entries(results)) out.push({ orgId, assetId, ...r });
        await workspace.reconcileDue();
      } catch (err) {
        // A workspace deleted mid-pass closes its handle under us; the rest still get their turn.
        out.push({ orgId, assetId: "", error: (err as Error).message });
      }
    }
    return out;
  }

  close(): void {
    for (const workspace of this.open.values()) workspace.db.close();
    this.open.clear();
  }
}
