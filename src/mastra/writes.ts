// Only use this when the provider confirms that the operation was not applied.
export class WriteNotAppliedError extends Error {}

export type WriteCheckpoint = <T>(operation: string, write: () => Promise<T>) => Promise<T>;
