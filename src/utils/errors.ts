export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  accountNotFound: (id: string) => new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${id} was not found.`),
  insufficientBalance: () => new AppError(409, 'INSUFFICIENT_BALANCE', 'The account has insufficient funds.'),
  duplicateReference: (existing: unknown) =>
    new AppError(
      409,
      'DUPLICATE_REFERENCE',
      'A record with this reference_id already exists for this account. No changes were made.',
      { existing },
    ),
  balanceLimit: () =>
    new AppError(409, 'BALANCE_LIMIT_EXCEEDED', 'The operation would exceed the maximum supported balance.'),
};
