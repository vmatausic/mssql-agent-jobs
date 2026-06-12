import * as vscode from "vscode";
import * as mssql from "mssql";
import { MssqlConnectionProfile } from "./types";

export class ConnectionManager {
  private pool: mssql.ConnectionPool | null = null;
  private currentProfile: MssqlConnectionProfile | null = null;

  constructor(private secrets: vscode.SecretStorage) {}

  getMssqlProfiles(): MssqlConnectionProfile[] {
    const config = vscode.workspace.getConfiguration("mssql");
    return config.get<MssqlConnectionProfile[]>("connections") ?? [];
  }

  async promptSelectProfile(): Promise<MssqlConnectionProfile | undefined> {
    const profiles = this.getMssqlProfiles();

    if (profiles.length === 0) {
      vscode.window.showWarningMessage(
        "No mssql connection profiles found. Add connections via the SQL Server (mssql) extension first."
      );
      return undefined;
    }

    const items = profiles.map((p) => ({
      label: p.profileName || p.server,
      description: `${p.server}${p.database ? " · " + p.database : ""} (${p.authenticationType})`,
      profile: p,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Select a SQL Server connection",
    });

    return picked?.profile;
  }

  async connect(profile: MssqlConnectionProfile): Promise<void> {
    await this.disconnect();

    let password = profile.password;
    let passwordFromCache = false;

    if (profile.authenticationType === "SqlLogin" && !password) {
      // mssql extension keeps SQL auth passwords in the OS credential store,
      // not in settings.json — so we prompt once and cache in SecretStorage.
      const cached = await this.secrets.get(secretKey(profile));
      if (cached) {
        password = cached;
        passwordFromCache = true;
      } else {
        password = await vscode.window.showInputBox({
          prompt: `Password for ${profile.user} @ ${profile.server}`,
          password: true,
          ignoreFocusOut: true,
        });
        if (password === undefined) {
          throw new Error("Connection cancelled — no password entered.");
        }
      }
    }

    try {
      this.pool = await new mssql.ConnectionPool(
        this.buildConfig(profile, password)
      ).connect();
    } catch (e) {
      // A cached password may be stale (changed on the server) — drop it so
      // the next attempt prompts again instead of failing forever.
      if (passwordFromCache) {
        await this.secrets.delete(secretKey(profile));
      }
      throw e;
    }

    if (profile.authenticationType === "SqlLogin" && password && !passwordFromCache) {
      await this.secrets.store(secretKey(profile), password);
    }

    this.currentProfile = profile;
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      this.currentProfile = null;
    }
  }

  async forgetPassword(profile: MssqlConnectionProfile): Promise<void> {
    await this.secrets.delete(secretKey(profile));
  }

  async query<T>(
    sql: string,
    configure?: (req: mssql.Request) => void
  ): Promise<T[]> {
    if (!this.pool) {
      throw new Error("Not connected. Select a connection first.");
    }
    const req = this.pool.request();
    configure?.(req);
    const result = await req.query(sql);
    return result.recordset as T[];
  }

  getCurrentProfile(): MssqlConnectionProfile | null {
    return this.currentProfile;
  }

  isConnected(): boolean {
    return this.pool !== null && this.pool.connected;
  }

  private buildConfig(
    profile: MssqlConnectionProfile,
    password: string | undefined
  ): mssql.config {
    const base: mssql.config = {
      server: profile.server,
      database: profile.database || "msdb",
      options: {
        encrypt: resolveEncrypt(profile.encrypt),
        trustServerCertificate: profile.trustServerCertificate ?? false,
        connectTimeout: (profile.connectTimeout ?? 15) * 1000,
      },
    };

    if (profile.authenticationType === "Integrated") {
      return { ...base, options: { ...base.options, trustedConnection: true } };
    }

    return { ...base, user: profile.user, password };
  }
}

function secretKey(profile: MssqlConnectionProfile): string {
  return `sqlAgentJobs:${profile.server}:${profile.database ?? ""}:${profile.user ?? ""}`;
}

function resolveEncrypt(encrypt: boolean | string | undefined): boolean {
  if (typeof encrypt === "string") {
    return encrypt.toLowerCase() !== "optional" && encrypt.toLowerCase() !== "false";
  }
  return encrypt ?? true;
}
