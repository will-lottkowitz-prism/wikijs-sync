// Local deletions waiting for the next sync to ask whether the server page
// should go too. No VS Code API beyond a Memento-shaped store, so it is
// unit-testable on its own (see pendingDeletes.unit.test.ts).

export interface PendingDelete {
  /** Wiki base URL and sync root the file lived under. */
  url: string;
  root: string;
  /** Page path the file mapped to when it was deleted. */
  path: string;
  /** Page id from the file's metadata, when it had one. */
  id?: number;
  /** `updatedAt` the file last synced at, to spot server edits since. */
  updatedAt?: string;
}

/** The slice of `vscode.Memento` this needs. */
export interface Store {
  get<T>(key: string, dflt: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const KEY = 'wikijsSync.pendingDeletes';

export const listPending = (store: Store): PendingDelete[] =>
  store.get<PendingDelete[]>(KEY, []);

const sameEntry = (a: PendingDelete, b: PendingDelete): boolean =>
  a.url === b.url &&
  a.root === b.root &&
  (a.id !== undefined && b.id !== undefined
    ? a.id === b.id
    : a.path.toLowerCase() === b.path.toLowerCase());

/** Records a deletion; a repeat of the same page replaces the earlier entry. */
export const addPending = async (
  store: Store,
  entry: PendingDelete
): Promise<void> => {
  const rest = listPending(store).filter((e) => !sameEntry(e, entry));
  await store.update(KEY, [...rest, entry]);
};

export const removePending = async (
  store: Store,
  entry: PendingDelete
): Promise<void> => {
  await store.update(
    KEY,
    listPending(store).filter((e) => e !== entry && !sameEntry(e, entry))
  );
};

/** The recorded deletion for a remote page: by id, else by path ignoring case. */
export const findPending = (
  entries: PendingDelete[],
  page: { id: number; path: string }
): PendingDelete | undefined =>
  entries.find((e) =>
    e.id !== undefined
      ? e.id === page.id
      : e.path.toLowerCase() === page.path.toLowerCase()
  );
