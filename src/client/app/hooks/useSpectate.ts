import { useEffect, useRef } from 'react';
import type React from 'react';
import { connectRealtime, disconnectRealtime, context } from '@devvit/web/client';
import type { SpectatorHandle } from '../components/SpectatorCanvas';

// Live spectating over Devvit realtime. Subscribes to the per-post `spectate_<postId>`
// channel and routes the artist's broadcast messages onto a SpectatorCanvas:
//   { t:'stroke' } -> draw live quadratic segments
//   { t:'key' }    -> repaint the authoritative keyframe (self-heal)
//   { t:'turn' }   -> notify the parent so the LIVE badge flips immediately
// The channel name matches the server (`spectate_${context.postId}`). Only the server can
// publish, so the artist's strokes round-trip through POST /api/stroke.

type SpectateMsg =
  | { t: 'stroke'; a: string; b?: { c?: string; o?: number }; segs: number[][] }
  | { t: 'key'; a: string; url: string; ver: number }
  | { t: 'turn'; a: string | null; windowEnd: number }
  | { t: 'clear'; a: string }
  | { t: 'fill'; a: string; x: number; y: number; c: string };

export function useSpectate(opts: {
  active: boolean;
  spectatorRef: React.RefObject<SpectatorHandle | null>;
  onTurn?: (artist: string | null, windowEnd: number) => void;
}) {
  const { active, spectatorRef, onTurn } = opts;
  const onTurnRef = useRef(onTurn);
  onTurnRef.current = onTurn;

  useEffect(() => {
    if (!active) return;
    const postId = context?.postId;
    if (!postId) return;
    const channel = `spectate_${postId}`;
    try {
      connectRealtime<SpectateMsg>({
        channel,
        onMessage: (msg) => {
          if (!msg || typeof msg !== 'object') return;
          if (msg.t === 'stroke') {
            spectatorRef.current?.applyStroke(msg.b ? { b: msg.b, segs: msg.segs } : { segs: msg.segs });
          } else if (msg.t === 'key') {
            if (msg.url) spectatorRef.current?.setKeyframe(msg.url);
          } else if (msg.t === 'turn') {
            onTurnRef.current?.(msg.a, msg.windowEnd);
          } else if (msg.t === 'clear') {
            spectatorRef.current?.applyClear();
          } else if (msg.t === 'fill') {
            spectatorRef.current?.applyFill(msg.x, msg.y, msg.c);
          }
        },
      });
    } catch {}
    return () => { try { disconnectRealtime(channel); } catch {} };
  }, [active]);
}
