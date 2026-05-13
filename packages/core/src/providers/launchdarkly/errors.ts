export class LdApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'LdApiError'
  }
}
