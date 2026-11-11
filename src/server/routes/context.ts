// ルートの部品が受け取るもの
import type { Hono } from "hono";
import type { HabitStore } from "../habits";
import type { TeamStore } from "../teams";
import type { WebPush } from "../webpush";
import type { Config } from "../config";
import type { DevService } from "../dev";
import type { MergeDesk } from "../merge";
import type { Hub } from "../hub";
import type { MediaService } from "../media";
import type { MemoStore } from "../memos";
import type { NotifyFeed } from "../notify-feed";
import type { ProjectStore } from "../projects";
import type { RootClient } from "../root";
import type { SessionService } from "../sessions";
import type { ShareStore } from "../share";
import type { ConnectionWatch } from "../connections";
import type { Store } from "../store";
import type { SystemService } from "../system";
import type { TaskSync } from "../task-sync";
import type { TaskStore } from "../tasks";
import type { WatchService } from "../watch";

/** アプリにつなぐ部品。無いものは、その機能だけ使えない */
import type { HermesNameSync } from "../hermes-names";

export interface AppServices {
  /** Plasmod の名前を Hermes の表示名に写す（#36）。Hermes につながっていなければ無い */
  names?: HermesNameSync;
  sessions?: SessionService;
  dev?: DevService;
  merge?: MergeDesk;
  shares?: ShareStore;
  system?: SystemService;
  media?: MediaService;
  rootd?: RootClient;
  watch?: WatchService;
  memos?: MemoStore;
  tasks?: TaskStore;
  taskSync?: TaskSync;
  projects?: ProjectStore;
  habits?: HabitStore;
  teams?: TeamStore;
  webPush?: WebPush;
  feed?: NotifyFeed;
  connections?: ConnectionWatch;
}

export interface RouteContext extends AppServices {
  app: Hono;
  cfg: Config;
  hub: Hub;
  store: Store;
}
