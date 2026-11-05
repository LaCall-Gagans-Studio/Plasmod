// テストは決まった名前で動かす（本番の名前は PLASMOD_PROFILES・PLASMOD_OWNER_NAME で決める）
process.env.PLASMOD_OWNER_NAME ??= "オーナーさん";
process.env.PLASMOD_TASK_PREFIX ??= "TASK";
process.env.PLASMOD_EXTRA_UNITS ??= "my-*.service";
process.env.PLASMOD_PROFILES ??= JSON.stringify([
  { id: "default", name: "ハブ", initial: "ミ", color: "#8FB8FF", aliases: ["hub1", "hub2"], role: "WINGMAN" },
  { id: "dev", name: "開発くん", initial: "つ", color: "#E8A27C", role: "DEVELOPER" },
  { id: "design", name: "デザインくん", initial: "ア", color: "#7FD8C6", aliases: ["dsn"], role: "DESIGNER" },
  { id: "acct", name: "経理くん", initial: "リ", color: "#F2C98A", aliases: ["acct1", "acct2"], role: "ACCOUNTANT" },
  { id: "auditor", name: "監査", initial: "監", color: "#3F4A5A", avatar: "/avatars/auditor.svg", team: "watch", role: "AUDITOR" },
  { id: "its", name: "ITS", initial: "I", color: "#2F6E6A", avatar: "/avatars/its.svg", team: "watch", role: "OPTIMIZER" },
  { id: "strategy", name: "戦略立案", initial: "戦", color: "#6B4E8C", avatar: "/avatars/strategy.svg", team: "watch", role: "STRATEGIST" },
]);
