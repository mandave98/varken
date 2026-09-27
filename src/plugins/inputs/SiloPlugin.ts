import axios, { type AxiosInstance } from 'axios';
import { BaseInputPlugin } from './BaseInputPlugin';
import { RequestCache } from '../../utils/RequestCache';
import type { PluginMetadata, DataPoint, ScheduleConfig } from '../../types/plugin.types';
import type {
  SiloConfig,
  SiloSession,
  SiloCollection,
  SiloStats,
  SiloTimeseries,
} from '../../types/inputs/silo.types';
import type { GeoIPInfo, TautulliApiResponse, TautulliGeoIPResponse } from '../../types/inputs/tautulli.types';

const PLAYER_STATE = { PLAYING: 0, PAUSED: 1 } as const;
const GEOIP_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOIP_CACHE_MAX = 1000;

/**
 * Silo input plugin.
 *
 * Reads Silo's native admin API with an admin API key (`Authorization: Bearer sa_…`):
 *   - `GET /api/v2/admin/sessions` — every live stream across all accounts
 *   - `GET /api/v2/admin/stats` — catalog / user / active-stream totals
 *   - `GET /api/v2/admin/stats/timeseries` — sampled concurrent streams and egress
 *
 * Session points use the same tag and field names as the Tautulli plugin. The
 * measurement defaults to `Silo`; set `measurement: Tautulli` (with an `id` no
 * Tautulli instance uses) to feed existing Tautulli dashboards directly, since
 * InfluxQL cannot merge two measurements into one series.
 *
 * Silo's Jellyfin-compatible `/Sessions` route is deliberately not used: it only
 * returns the calling token's own sessions.
 */
export class SiloPlugin extends BaseInputPlugin<SiloConfig> {
  readonly metadata: PluginMetadata = {
    name: 'Silo',
    version: '1.0.0',
    description: 'Collects live sessions and dashboard stats from Silo',
  };

  private measurement = 'Silo';
  private geoipClient: AxiosInstance | null = null;
  private geoipCache = new RequestCache<GeoIPInfo | null>({
    ttlMs: GEOIP_CACHE_TTL_MS,
    maxSize: GEOIP_CACHE_MAX,
  });

  async initialize(...args: Parameters<BaseInputPlugin<SiloConfig>['initialize']>): Promise<void> {
    await super.initialize(...args);
    this.measurement = (this.config.measurement || 'Silo').trim() || 'Silo';
    this.httpClient.defaults.headers.common['Authorization'] = `Bearer ${this.config.apiKey}`;

    if (this.config.geoip?.enabled && this.config.geoip.tautulli) {
      this.geoipClient = axios.create({
        baseURL: this.config.geoip.tautulli.url,
        timeout: this.globalConfig.httpTimeoutMs,
        headers: { Accept: 'application/json' },
      });
    } else if (this.config.geoip?.enabled) {
      this.logger.warn('geoip.enabled is set but geoip.tautulli is not; remote sessions will have no location');
    }
  }

  protected getHealthEndpoint(): string {
    return '/api/v1/health';
  }

  async collect(): Promise<DataPoint[]> {
    const points: DataPoint[] = [];

    if (this.config.sessions.enabled) {
      points.push(...(await this.collectSessions()));
    }

    if (this.config.stats.enabled) {
      points.push(...(await this.collectStats()));
    }

    return points;
  }

  getSchedules(): ScheduleConfig[] {
    const schedules: ScheduleConfig[] = [];

    if (this.config.sessions.enabled) {
      schedules.push(
        this.createSchedule('sessions', this.config.sessions.intervalSeconds, true, this.collectSessions)
      );
    }

    if (this.config.stats.enabled) {
      schedules.push(this.createSchedule('stats', this.config.stats.intervalSeconds, true, this.collectStats));
    }

    return schedules;
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  private async collectSessions(): Promise<DataPoint[]> {
    return this.safeFetch('collect Silo sessions', async () => {
      const points: DataPoint[] = [];
      const response = await this.httpGet<SiloCollection<SiloSession>>('/api/v2/admin/sessions');
      const sessions = response?.items ?? [];

      let totalBandwidth = 0;
      let wanBandwidth = 0;
      let lanBandwidth = 0;
      let transcodeStreams = 0;
      let directPlayStreams = 0;
      let directStreams = 0;

      for (const session of sessions) {
        points.push(await this.processSession(session));

        const kbps = session.stream_bitrate_kbps ?? 0;
        totalBandwidth += kbps;
        if (this.isLocalSession(session)) {
          lanBandwidth += kbps;
        } else {
          wanBandwidth += kbps;
        }

        switch (this.normalizePlayMethod(session)) {
          case 'transcode':
            transcodeStreams++;
            break;
          case 'direct stream':
            directStreams++;
            break;
          default:
            directPlayStreams++;
        }
      }

      points.push(
        this.createDataPoint(
          this.measurement,
          {
            type: 'current_stream_stats',
            server: this.config.id,
          },
          {
            stream_count: sessions.length,
            total_bandwidth: totalBandwidth,
            wan_bandwidth: wanBandwidth,
            lan_bandwidth: lanBandwidth,
            transcode_streams: transcodeStreams,
            direct_play_streams: directPlayStreams,
            direct_streams: directStreams,
          }
        )
      );

      this.logger.info(`Collected ${sessions.length} Silo sessions`);
      return points;
    });
  }

  private async processSession(session: SiloSession): Promise<DataPoint> {
    const ip = session.client_ip || '';
    const isLocal = this.isLocalSession(session);

    let geoData: GeoIPInfo | null = null;
    if (this.geoipClient && !isLocal && ip) {
      geoData = await this.geoipLookup(ip);
    }

    let latitude: number | undefined;
    let longitude: number | undefined;
    let location = 'unknown';
    let regionCode = 'unknown';
    let fullLocation = 'unknown';

    if (isLocal) {
      location = 'Local';
      fullLocation = 'Local Network';
      regionCode = 'LAN';
      if (this.config.geoip?.localCoordinates) {
        latitude = this.config.geoip.localCoordinates.latitude;
        longitude = this.config.geoip.localCoordinates.longitude;
      }
    } else if (geoData) {
      latitude = geoData.latitude;
      longitude = geoData.longitude;
      location = geoData.city || 'unknown';
      regionCode = geoData.region || 'unknown';
      const regionPart = geoData.region || '';
      const cityPart = geoData.city || '';
      fullLocation = regionPart && cityPart ? `${regionPart} - ${cityPart}` : regionPart || cityPart || 'unknown';
    }

    const transcodeDecision = this.normalizePlayMethod(session);
    const videoDecision = this.normalizeDecision(session.video_decision) || transcodeDecision;
    const playerState = session.is_paused ? PLAYER_STATE.PAUSED : PLAYER_STATE.PLAYING;
    const hwAccel = (session.transcode_hw_accel || '').trim();
    const hwFlag = transcodeDecision === 'transcode' && hwAccel !== '' && hwAccel !== 'none' ? 1 : 0;

    const fullTitle = this.fullTitle(session);
    const quality = this.quality(session);
    const hashId = this.hashit(`${session.session_id}${session.username}${fullTitle}`);

    const duration = session.file_duration ?? 0;
    const progressPercent =
      duration > 0 ? Math.min(100, Math.max(0, Math.round((session.position_seconds / duration) * 100))) : 0;

    const tags: Record<string, string | number> = {
      type: 'Session',
      session_id: session.session_id || 'unknown',
      ip_address: ip || 'unknown',
      friendly_name: session.profile_name || session.username || 'unknown',
      username: session.username || 'unknown',
      title: fullTitle,
      product: session.client_name || 'unknown',
      platform: session.client_channel || session.client_label || 'unknown',
      product_version: session.client_version || 'unknown',
      quality,
      video_decision: this.titleCase(videoDecision),
      transcode_decision: this.titleCase(transcodeDecision),
      transcode_hw_decoding: hwFlag,
      transcode_hw_encoding: hwFlag,
      media_type: this.titleCase(session.media_type || '') || 'unknown',
      audio_codec: (session.source_audio_codec || '').toUpperCase() || 'unknown',
      stream_audio_codec: (session.target_audio_codec || session.source_audio_codec || '').toUpperCase() || 'unknown',
      quality_profile: session.target_resolution || 'Original',
      region_code: regionCode,
      location,
      full_location: fullLocation,
      player_state: playerState,
      device_type: session.client_label || session.client_name || 'unknown',
      relay: session.routing_egress && session.routing_egress !== 'api' ? 1 : 0,
      secure: '1',
      hw_accel: hwAccel || 'none',
      server: this.config.id,
    };

    if (latitude !== undefined) {
      tags.latitude = latitude;
    }
    if (longitude !== undefined) {
      tags.longitude = longitude;
    }

    return this.createDataPoint(this.measurement, tags, {
      hash: hashId,
      progress_percent: progressPercent,
      position_seconds: Math.round(session.position_seconds || 0),
      stream_bitrate_kbps: session.stream_bitrate_kbps ?? 0,
      source_bitrate_kbps: session.source_bitrate_kbps ?? 0,
    });
  }

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  private async collectStats(): Promise<DataPoint[]> {
    return this.safeFetch('collect Silo stats', async () => {
      const points: DataPoint[] = [];

      const [stats, timeseries] = await Promise.all([
        this.httpGet<SiloStats>('/api/v2/admin/stats'),
        this.fetchTimeseries(),
      ]);

      if (stats) {
        points.push(
          this.createDataPoint(
            this.measurement,
            {
              type: 'server_stats',
              server: this.config.id,
            },
            {
              total_items: stats.total_items ?? 0,
              total_files: stats.total_files ?? 0,
              total_users: stats.total_users ?? 0,
              total_movies: stats.total_movies ?? 0,
              total_shows: stats.total_shows ?? 0,
              active_streams: stats.active_streams ?? 0,
              total_storage_bytes: stats.total_storage_bytes ?? 0,
            }
          )
        );
      }

      // Every sample of the last hour is written with its own timestamp; the same
      // timestamp and tags overwrite in place, so re-reading a window is idempotent.
      for (const point of timeseries?.points ?? []) {
        const ts = new Date(point.t);
        if (Number.isNaN(ts.getTime())) {
          continue;
        }
        points.push(
          this.createDataPoint(
            this.measurement,
            {
              type: 'stream_timeseries',
              server: this.config.id,
            },
            {
              streams: point.streams ?? 0,
              direct: point.direct ?? 0,
              remux: point.remux ?? 0,
              transcode: point.transcode ?? 0,
              egress_kbps: point.egress_kbps ?? 0,
              download_egress_kbps: point.download_egress_kbps ?? 0,
            },
            ts
          )
        );
      }

      this.logger.info(`Collected Silo stats (${timeseries?.points?.length ?? 0} timeseries samples)`);
      return points;
    });
  }

  /** Non-fatal: the totals point is still worth writing when the timeseries read fails. */
  private async fetchTimeseries(): Promise<SiloTimeseries | null> {
    try {
      return await this.httpGet<SiloTimeseries>('/api/v2/admin/stats/timeseries', { hours: 1 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`Could not fetch Silo timeseries: ${message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** `direct` → direct play, `remux` → direct stream, `transcode` → transcode. */
  private normalizePlayMethod(session: SiloSession): 'direct play' | 'direct stream' | 'transcode' {
    const method = (session.effective_play_method || session.play_method || '').toLowerCase();
    if (method === 'transcode') {
      return 'transcode';
    }
    if (method === 'remux' || method === 'direct_stream') {
      return 'direct stream';
    }
    return 'direct play';
  }

  private normalizeDecision(value?: string): string {
    switch ((value || '').toLowerCase()) {
      case 'transcode':
        return 'transcode';
      case 'direct_stream':
      case 'remux':
      case 'copy':
        return 'direct stream';
      case 'direct_play':
      case 'direct':
        return 'direct play';
      default:
        return '';
    }
  }

  private fullTitle(session: SiloSession): string {
    if (session.series_name) {
      const episode = session.episode_name || session.media_title;
      const s = session.season_number;
      const e = session.episode_number;
      const code =
        typeof s === 'number' && typeof e === 'number'
          ? ` S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`
          : '';
      return `${session.series_name} -${code} ${episode}`.replace(' -  ', ' - ');
    }
    return session.media_title || 'unknown';
  }

  /** `1080p` style, from the delivered resolution when transcoding, else the source. */
  private quality(session: SiloSession): string {
    const raw = (session.target_resolution || session.source_video_resolution || '').trim();
    if (!raw) {
      return (session.output_container || session.source_container || '').toUpperCase() || 'unknown';
    }
    const lower = raw.toLowerCase();
    if (lower === '4k' || lower === 'sd') {
      return raw.toUpperCase();
    }
    if (/^\d+$/.test(lower)) {
      return `${lower}p`;
    }
    // "1920x1080" style → "1080p"
    const wxh = lower.match(/^(\d+)x(\d+)$/);
    if (wxh) {
      return `${wxh[2]}p`;
    }
    return raw;
  }

  private isLocalSession(session: SiloSession): boolean {
    if ((session.stream_location || '').toLowerCase() === 'local') {
      return true;
    }
    return session.client_ip ? this.isPrivateIP(session.client_ip) : false;
  }

  private isPrivateIP(ip: string): boolean {
    return (
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
      /^127\./.test(ip) ||
      /^::1$/.test(ip) ||
      /^f[cd][0-9a-f]{2}:/i.test(ip) ||
      /^fe80:/i.test(ip)
    );
  }

  private async geoipLookup(ip: string): Promise<GeoIPInfo | null> {
    return this.geoipCache.getOrFetch(ip, async () => {
      if (!this.geoipClient || !this.config.geoip.tautulli) {
        return null;
      }
      try {
        const response = await this.geoipClient.get<TautulliApiResponse<TautulliGeoIPResponse>>('/api/v2', {
          params: {
            apikey: this.config.geoip.tautulli.apiKey,
            cmd: 'get_geoip_lookup',
            ip_address: ip,
          },
        });
        const data = response.data?.response?.data;
        if (!data || response.data?.response?.result !== 'success') {
          return null;
        }
        return {
          city: data.city || '',
          region: data.region || '',
          country: data.country || '',
          latitude: data.latitude || 0,
          longitude: data.longitude || 0,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        this.logger.debug(`GeoIP lookup failed for ${this.maskIp(ip)}: ${message}`);
        return null;
      }
    });
  }

  private maskIp(ip: string): string {
    const parts = ip.split('.');
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'x:x:x';
  }

  /** First letter only, exactly like the Tautulli plugin, so "Direct play" matches existing panel filters. */
  private titleCase(str: string): string {
    if (!str) {
      return '';
    }
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
  }
}
