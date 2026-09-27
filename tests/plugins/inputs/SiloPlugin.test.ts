import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { SiloPlugin } from '../../../src/plugins/inputs/SiloPlugin';
import type { SiloConfig, SiloSession } from '../../../src/types/inputs/silo.types';
import axios from 'axios';
import { createMockHttpClient, type MockHttpClient } from '../../fixtures/http';

vi.mock('../../../src/core/Logger', async () => {
  const { loggerMock } = await import('../../fixtures/logger');
  return loggerMock();
});

vi.mock('axios', () => ({ default: { create: vi.fn() } }));

const baseSession: SiloSession = {
  session_id: 'sess-1',
  user_id: 7,
  username: 'alice@example.com',
  profile_id: 'p1',
  profile_name: 'Alice',
  media_file_id: 42,
  media_title: 'Pilot',
  media_type: 'episode',
  series_name: 'Some Show',
  episode_name: 'Pilot',
  season_number: 1,
  episode_number: 3,
  play_method: 'transcode',
  reporting_node: 'integrated',
  file_duration: 1000,
  started_at: '2026-09-27T00:00:00Z',
  updated_at: '2026-09-27T00:04:10Z',
  position_seconds: 250,
  is_paused: false,
  client_ip: '203.0.113.9',
  stream_location: 'remote',
  client_name: 'Silo Web',
  client_version: '0.0.1',
  client_channel: 'web',
  client_label: 'Silo Web on Chrome',
  transcode_audio: false,
  stream_bitrate_kbps: 8000,
  target_resolution: '1080',
  target_video_codec: 'h264',
  target_audio_codec: 'aac',
  transcode_hw_accel: 'qsv',
  source_container: 'mkv',
  source_bitrate_kbps: 24000,
  source_video_codec: 'hevc',
  source_video_resolution: '2160',
  source_audio_codec: 'truehd',
  video_decision: 'transcode',
  audio_decision: 'transcode',
  effective_play_method: 'transcode',
  routing_egress: 'proxy',
};

const config: SiloConfig = {
  id: 1,
  url: 'http://silo.local:8090',
  apiKey: 'sa_test',
  verifySsl: false,
  sessions: { enabled: true, intervalSeconds: 30 },
  stats: { enabled: true, intervalSeconds: 300 },
  geoip: { enabled: false, localCoordinates: { latitude: 48.0, longitude: -122.0 } },
};

describe('SiloPlugin', () => {
  let plugin: SiloPlugin;
  let http: MockHttpClient;

  beforeEach(() => {
    vi.clearAllMocks();
    plugin = new SiloPlugin();
    http = createMockHttpClient();
    (axios.create as Mock).mockReturnValue(http);
  });

  describe('metadata and setup', () => {
    it('registers under the config key "silo"', () => {
      expect(plugin.metadata.name).toBe('Silo');
    });

    it('sends the admin API key as a bearer token', async () => {
      await plugin.initialize(config);
      expect(http.defaults.headers.common['Authorization']).toBe('Bearer sa_test');
    });

    it('returns only enabled schedules', async () => {
      await plugin.initialize({ ...config, stats: { enabled: false, intervalSeconds: 300 } });
      expect(plugin.getSchedules().map((s) => s.name)).toEqual(['Silo_1_sessions']);
    });
  });

  describe('sessions', () => {
    beforeEach(async () => {
      await plugin.initialize({ ...config, stats: { enabled: false, intervalSeconds: 300 } });
    });

    it('writes one Tautulli-shaped Session point per live stream', async () => {
      http.get.mockResolvedValueOnce({ data: { items: [baseSession] } });

      const points = await plugin.collect();
      const session = points.find((p) => p.tags.type === 'Session');

      expect(session?.measurement).toBe('Silo');
      expect(session?.tags.username).toBe('alice@example.com');
      expect(session?.tags.friendly_name).toBe('Alice');
      expect(session?.tags.title).toBe('Some Show - S01E03 Pilot');
      expect(session?.tags.quality).toBe('1080p');
      expect(session?.tags.transcode_decision).toBe('Transcode');
      expect(session?.tags.video_decision).toBe('Transcode');
      expect(session?.tags.transcode_hw_encoding).toBe(1);
      expect(session?.tags.hw_accel).toBe('qsv');
      expect(session?.tags.audio_codec).toBe('TRUEHD');
      expect(session?.tags.stream_audio_codec).toBe('AAC');
      expect(session?.tags.media_type).toBe('Episode');
      expect(session?.tags.player_state).toBe(0);
      expect(session?.tags.relay).toBe(1);
      expect(session?.tags.server).toBe(1);
      expect(session?.fields.progress_percent).toBe(25);
      expect(session?.fields.stream_bitrate_kbps).toBe(8000);
      expect(session?.fields.source_bitrate_kbps).toBe(24000);
    });

    it('never calls the Jellyfin-compatible route', async () => {
      http.get.mockResolvedValueOnce({ data: { items: [] } });
      await plugin.collect();
      expect(http.get).toHaveBeenCalledWith('/api/v2/admin/sessions', expect.anything());
      expect(http.get).not.toHaveBeenCalledWith('/Sessions', expect.anything());
    });

    it('treats a private client IP or stream_location=local as LAN with local coordinates', async () => {
      const lan = { ...baseSession, session_id: 'lan', client_ip: '192.168.1.50', stream_location: 'remote' };
      const flagged = { ...baseSession, session_id: 'flag', client_ip: '8.8.8.8', stream_location: 'local' };
      http.get.mockResolvedValueOnce({ data: { items: [lan, flagged] } });

      const points = (await plugin.collect()).filter((p) => p.tags.type === 'Session');
      for (const p of points) {
        expect(p.tags.location).toBe('Local');
        expect(p.tags.region_code).toBe('LAN');
        expect(p.tags.latitude).toBe(48.0);
        expect(p.tags.longitude).toBe(-122.0);
      }
    });

    it('maps direct and remux play methods and paused state', async () => {
      const direct = {
        ...baseSession,
        session_id: 'd',
        play_method: 'direct',
        effective_play_method: 'direct',
        video_decision: 'direct_play',
        transcode_hw_accel: '',
        target_resolution: '',
        is_paused: true,
      };
      const remux = { ...baseSession, session_id: 'r', play_method: 'remux', effective_play_method: 'remux', video_decision: 'direct_stream' };
      http.get.mockResolvedValueOnce({ data: { items: [direct, remux] } });

      const points = await plugin.collect();
      const d = points.find((p) => p.tags.session_id === 'd');
      const r = points.find((p) => p.tags.session_id === 'r');

      expect(d?.tags.transcode_decision).toBe('Direct play');
      expect(d?.tags.video_decision).toBe('Direct play');
      expect(d?.tags.transcode_hw_encoding).toBe(0);
      expect(d?.tags.quality).toBe('2160p');
      expect(d?.tags.player_state).toBe(1);
      expect(r?.tags.transcode_decision).toBe('Direct stream');
      expect(r?.tags.video_decision).toBe('Direct stream');
    });

    it('writes a current_stream_stats summary with bandwidth split by location', async () => {
      const lan = { ...baseSession, session_id: 'lan', client_ip: '10.0.0.2', stream_bitrate_kbps: 3000, play_method: 'direct', effective_play_method: 'direct' };
      http.get.mockResolvedValueOnce({ data: { items: [baseSession, lan] } });

      const points = await plugin.collect();
      const summary = points.find((p) => p.tags.type === 'current_stream_stats');

      expect(summary?.fields.stream_count).toBe(2);
      expect(summary?.fields.total_bandwidth).toBe(11000);
      expect(summary?.fields.wan_bandwidth).toBe(8000);
      expect(summary?.fields.lan_bandwidth).toBe(3000);
      expect(summary?.fields.transcode_streams).toBe(1);
      expect(summary?.fields.direct_play_streams).toBe(1);
    });

    it('uses a movie title as-is and the container when no resolution is known', async () => {
      const movie = {
        ...baseSession,
        session_id: 'm',
        media_type: 'movie',
        media_title: 'Heat',
        series_name: undefined,
        episode_name: undefined,
        target_resolution: '',
        source_video_resolution: '',
      };
      http.get.mockResolvedValueOnce({ data: { items: [movie] } });

      const points = await plugin.collect();
      const m = points.find((p) => p.tags.session_id === 'm');
      expect(m?.tags.title).toBe('Heat');
      expect(m?.tags.media_type).toBe('Movie');
      expect(m?.tags.quality).toBe('MKV');
    });
  });

  describe('measurement override', () => {
    it('writes every point into the configured measurement', async () => {
      await plugin.initialize({ ...config, measurement: 'Tautulli' });
      http.get
        .mockResolvedValueOnce({ data: { items: [baseSession] } })
        .mockResolvedValueOnce({ data: { total_items: 1, total_files: 1, total_users: 1, active_streams: 1, total_storage_bytes: 1 } })
        .mockResolvedValueOnce({ data: { resolution_seconds: 60, from: '', to: '', points: [{ t: '2026-09-27T00:59:00Z', streams: 1, egress_kbps: 1 }] } });

      const points = await plugin.collect();
      expect(points.length).toBeGreaterThanOrEqual(4);
      expect(new Set(points.map((p) => p.measurement))).toEqual(new Set(['Tautulli']));
    });
  });

  describe('geoip', () => {
    it('resolves remote IPs through the configured Tautulli and caches the answer', async () => {
      const geoClient = createMockHttpClient();
      (axios.create as Mock).mockReturnValueOnce(http).mockReturnValueOnce(geoClient);
      await plugin.initialize({
        ...config,
        stats: { enabled: false, intervalSeconds: 300 },
        geoip: { enabled: true, tautulli: { url: 'http://tautulli.local:8181', apiKey: 'tk' } },
      });
      geoClient.get.mockResolvedValue({
        data: {
          response: {
            result: 'success',
            data: { city: 'Seattle', region: 'Washington', country: 'United States', latitude: 47.6, longitude: -122.3 },
          },
        },
      });
      http.get.mockResolvedValue({ data: { items: [baseSession] } });

      const first = (await plugin.collect()).find((p) => p.tags.type === 'Session');
      await plugin.collect();

      expect(first?.tags.location).toBe('Seattle');
      expect(first?.tags.full_location).toBe('Washington - Seattle');
      expect(first?.tags.latitude).toBe(47.6);
      expect(geoClient.get).toHaveBeenCalledTimes(1);
      expect(geoClient.get).toHaveBeenCalledWith(
        '/api/v2',
        expect.objectContaining({ params: expect.objectContaining({ cmd: 'get_geoip_lookup', ip_address: '203.0.113.9' }) })
      );
    });
  });

  describe('stats', () => {
    beforeEach(async () => {
      await plugin.initialize({ ...config, sessions: { enabled: false, intervalSeconds: 30 } });
    });

    it('writes server totals and one timeseries point per sample with the sample timestamp', async () => {
      http.get
        .mockResolvedValueOnce({
          data: { total_items: 10, total_files: 12, total_users: 3, total_movies: 4, total_shows: 2, active_streams: 1, total_storage_bytes: 999 },
        })
        .mockResolvedValueOnce({
          data: {
            resolution_seconds: 60,
            from: '2026-09-27T00:00:00Z',
            to: '2026-09-27T01:00:00Z',
            points: [
              { t: '2026-09-27T00:58:00Z', streams: 2, direct: 1, remux: 0, transcode: 1, egress_kbps: 12000, download_egress_kbps: 0 },
              { t: '2026-09-27T00:59:00Z', streams: 3, direct: 1, remux: 1, transcode: 1, egress_kbps: 15000 },
            ],
          },
        });

      const points = await plugin.collect();
      const totals = points.find((p) => p.tags.type === 'server_stats');
      const series = points.filter((p) => p.tags.type === 'stream_timeseries');

      expect(totals?.fields.total_users).toBe(3);
      expect(totals?.fields.active_streams).toBe(1);
      expect(series).toHaveLength(2);
      expect(series[1].fields.streams).toBe(3);
      expect(series[1].fields.download_egress_kbps).toBe(0);
      expect(series[1].timestamp.toISOString()).toBe('2026-09-27T00:59:00.000Z');
      expect(http.get).toHaveBeenCalledWith('/api/v2/admin/stats/timeseries', expect.objectContaining({ params: { hours: 1 } }));
    });

    it('still writes totals when the timeseries read fails', async () => {
      http.get
        .mockResolvedValueOnce({ data: { total_items: 1, total_files: 1, total_users: 1, active_streams: 0, total_storage_bytes: 1 } })
        .mockRejectedValueOnce(new Error('boom'));

      const points = await plugin.collect();
      expect(points.filter((p) => p.tags.type === 'server_stats')).toHaveLength(1);
      expect(points.filter((p) => p.tags.type === 'stream_timeseries')).toHaveLength(0);
    });
  });
});
