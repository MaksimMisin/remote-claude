import { useState, useRef, useCallback } from 'react';

interface UseNotificationsReturn {
  enabled: boolean;
  toggle: () => void;
  notify: (title: string, body: string, urgent: boolean) => void;
}

export function useNotifications(): UseNotificationsReturn {
  const [enabled, setEnabled] = useState(() => {
    return (
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    );
  });
  const audioCtxRef = useRef<AudioContext | null>(null);

  const getAudioCtx = useCallback((): AudioContext => {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext)();
    }
    return audioCtxRef.current;
  }, []);

  const playSound = useCallback(
    (urgent: boolean) => {
      try {
        const ctx = getAudioCtx();
        if (ctx.state === 'suspended') ctx.resume();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        gain.gain.value = 0.3;

        if (urgent) {
          // Two-tone urgent alert
          osc.frequency.value = 880;
          osc.start(ctx.currentTime);
          osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
          osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
          gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.4);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          osc.stop(ctx.currentTime + 0.5);
        } else {
          // Gentle chime
          osc.frequency.value = 587;
          osc.start(ctx.currentTime);
          osc.frequency.setValueAtTime(784, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.2, ctx.currentTime + 0.2);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
          osc.stop(ctx.currentTime + 0.4);
        }
      } catch {
        // Audio not available
      }
    },
    [getAudioCtx],
  );

  const notify = useCallback(
    (title: string, body: string, urgent: boolean) => {
      // Play sound
      playSound(urgent);

      // Vibrate on mobile
      if (navigator.vibrate) {
        navigator.vibrate(urgent ? [200, 100, 200] : [100]);
      }

      // Web Notification (only if page not focused)
      if (enabled && document.hidden) {
        try {
          const icon = urgent ? '\u26A0\uFE0F' : '\u2705';
          const n = new Notification(title, {
            body,
            icon:
              'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">' +
              icon +
              '</text></svg>',
            tag: 'rc-' + Date.now(),
            requireInteraction: urgent,
          });
          n.onclick = () => {
            window.focus();
            n.close();
          };
        } catch {
          // Notification not available
        }
      }
    },
    [enabled, playSound],
  );

  const toggle = useCallback(() => {
    if (typeof Notification === 'undefined') {
      return;
    }

    // Initialize AudioContext on user gesture
    getAudioCtx();

    if (Notification.permission === 'granted') {
      setEnabled((prev) => {
        if (prev) return false;
        playSound(false); // test sound
        return true;
      });
    } else if (Notification.permission === 'denied') {
      // Cannot request -- blocked in browser settings
      return;
    } else {
      Notification.requestPermission().then((perm) => {
        const granted = perm === 'granted';
        setEnabled(granted);
        if (granted) playSound(false);
      });
    }
  }, [getAudioCtx, playSound]);

  return { enabled, toggle, notify };
}
