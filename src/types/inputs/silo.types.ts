import type { BaseInputConfig } from '../../plugins/inputs/BaseInputPlugin';

/**
 * Silo input plugin configuration.
 * Silo (silo-server) is a media server with a native admin API; this plugin
 * reads `GET /api/v2/admin/sessions`, `GET /api/v2/admin/stats` and
 * `GET /api/v2/admin/stats/timeseries`, all of which need an admin API key.
 */
export interface SiloConfig extends BaseInputConfig {
  apiKey: string;
  sessions: {
    enabled: boolean;
    intervalSeconds: number;
  };
  stats: {
    enabled: boolean;
    intervalSeconds: number;
  };
  geoip: {
    enabled: boolean;
    /** Silo has no GeoIP; remote IPs are resolved through this Tautulli when set. */
    tautulli?: {
      url: string;
      apiKey: string;
    };
    localCoordinates?: {
      latitude: number;
      longitude: number;
    };
  };
}

/** One live playback observation from `GET /api/v2/admin/sessions` (fields this plugin reads). */
export interface SiloSession {
  session_id: string;
  user_id: string | number;
  username: string;
  profile_id: string;
  profile_name?: string;
  media_file_id: string | number;
  content_id?: string;
  media_title: string;
  /** e.g. `movie`, `episode`, `track` */
  media_type: string;
  series_name?: string;
  episode_name?: string;
  season_number?: number | null;
  episode_number?: number | null;
  /** `direct`, `remux` or `transcode` */
  play_method: string;
  reporting_node: string;
  node_display_name?: string;
  file_duration?: number | null;
  started_at: string;
  updated_at: string;
  position_seconds: number;
  is_paused: boolean;
  client_ip?: string;
  /** `local` or `remote` */
  stream_location?: string;
  client_name?: string;
  client_version?: string;
  client_channel?: string;
  client_label?: string;
  client_label_full?: string;
  transcode_audio: boolean;
  stream_bitrate_kbps?: number | null;
  target_resolution?: string;
  target_video_codec?: string;
  target_audio_codec?: string;
  target_bitrate_kbps?: number | null;
  /** `qsv`, `vaapi`, `nvenc`, `videotoolbox`, or empty for software / no transcode */
  transcode_hw_accel?: string;
  tone_map_mode?: string;
  output_container?: string;
  source_container?: string;
  source_bitrate_kbps?: number | null;
  source_video_codec?: string;
  source_video_resolution?: string;
  source_audio_codec?: string;
  source_audio_channels?: number | null;
  /** `direct_play`, `direct_stream`, `transcode` */
  video_decision?: string;
  audio_decision?: string;
  effective_play_method?: string;
  is_jellyfin_client?: boolean;
  routing_execution?: string;
  routing_egress?: string;
  routing_egress_node_name?: string;
}

/** `GET /api/v2/admin/sessions` envelope. */
export interface SiloCollection<T> {
  items: T[];
}

/** `GET /api/v2/admin/stats` (fields this plugin reads). */
export interface SiloStats {
  total_items: number;
  total_files: number;
  total_users: number;
  total_movies?: number;
  total_movie_files?: number;
  total_shows?: number;
  total_show_files?: number;
  active_streams: number;
  total_storage_bytes: number;
}

/** One sample from `GET /api/v2/admin/stats/timeseries`. */
export interface SiloTimeseriesPoint {
  t: string;
  streams: number;
  direct?: number;
  remux?: number;
  transcode?: number;
  egress_kbps: number;
  download_egress_kbps?: number;
}

export interface SiloTimeseries {
  resolution_seconds: number;
  from: string;
  to: string;
  points: SiloTimeseriesPoint[];
}
