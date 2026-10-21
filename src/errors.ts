/** Error de uso/configuración: se muestra al usuario sin stack trace. */
export class UserError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 2) {
    super(message);
    this.name = "UserError";
    this.exitCode = exitCode;
  }
}

export class ConfigError extends UserError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
