export type EngageDiscoveryMode = "active" | "pause_new";

export function parseEngageDiscoveryMode(value: string | undefined): EngageDiscoveryMode {
  const mode = value ?? "active";
  if (mode !== "active" && mode !== "pause_new") {
    throw new Error(`ENGAGE_DISCOVERY_MODE must be active or pause_new, received ${value}`);
  }
  return mode;
}

export function engageEntryAction(mode: EngageDiscoveryMode, alreadyStored: boolean):
  "fetch_detail" | "observe_existing" | "ignore_new" {
  if (mode === "active") return "fetch_detail";
  return alreadyStored ? "observe_existing" : "ignore_new";
}
