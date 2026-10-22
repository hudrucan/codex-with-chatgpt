/** Lifecycle and status contracts shared by Cloudflare Quick and Named Tunnels. */
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  detail?: string;
}

export interface TunnelDoctorReport {
  provider: string;
  binaryFound: boolean;
  binaryPath: string | null;
  running: boolean;
  url: string | null;
  problems: string[];
}

export interface TunnelProvider {
  readonly name: string;
  /** Start the tunnel for a local port; resolves with the public URL. */
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  restart(localPort: number): Promise<string>;
  status(): TunnelStatus;
  getPublicUrl(): string | null;
  doctor(): Promise<TunnelDoctorReport>;
}
