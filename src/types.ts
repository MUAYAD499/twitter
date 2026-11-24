export interface AuthorizedUser {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  phone: string;
}

export type CodeDeliveryType =
  | "app"
  | "email"
  | "sms"
  | "call"
  | "fragment"
  | "firebase"
  | "setup_email"
  | "unknown";

export interface AuthDeliveryInfo {
  deliveryType: CodeDeliveryType;
  label: string;
  detail: string;
  emailPattern: string;
  fragmentUrl: string;
  codeLength: number;
  nextTypeLabel: string;
  timeoutSeconds: number;
}

export interface TargetGroup {
  id: string;
  title: string;
  roleLabel: string;
  isAdmin: boolean;
  membersCount: number;
  username: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export type GroupDeliveryStatus = "pending" | "sending" | "sent" | "skipped" | "error";

export interface GroupStatusRecord {
  groupId: string;
  title: string;
  status: GroupDeliveryStatus;
  detail: string;
  assignedTemplateTitle: string;
  cycleNumber: number;
  updatedAt: string;
}

export interface BroadcastState {
  status: "idle" | "running" | "waiting" | "flood_wait" | "completed" | "stopped";
  currentCycle: number;
  totalCyclesCompleted: number;
  totalTargets: number;
  processedCount: number;
  succeededCount: number;
  totalSentAllCycles: number;
  skippedCount: number;
  failedCount: number;
  floodWaitsCount: number;
  newGroupsDiscoveredCount: number;
  currentGroupTitle: string;
  countdownSeconds: number;
  countdownReason: string;
  startedAt: string | null;
  finishedAt: string | null;
  groupStatuses: Record<string, GroupStatusRecord>;
  logs: LogEntry[];
}

export interface KeepAliveStats {
  startedAt: string;
  pingCount: number;
  lastPingAt: string | null;
  pingPath: string;
}

export interface TemplateItem {
  id: string;
  title: string;
  content: string;
}
