export class ProviderUnavailableError extends Error {
  readonly provider: string;
  readonly retryable = true;

  constructor(provider: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderUnavailableError';
    this.provider = provider;
  }
}
