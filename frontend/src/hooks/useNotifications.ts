import { useState, useRef, useCallback, useEffect } from 'react';

export type NotificationMode = 'off' | 'silent' | 'vibrate' | 'full';

const MODE_CYCLE: NotificationMode[] = ['off', 'silent', 'vibrate', 'full'];
const STORAGE_KEY = 'rc-notification-mode';

interface UseNotificationsReturn {
  mode: NotificationMode;
  toggle: () => void;
  notify: (title: string, body: string, urgent: boolean, forceShow?: boolean) => void;
}

export function useNotifications(): UseNotificationsReturn {
  const [mode, setMode] = useState<NotificationMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as NotificationMode | null;
    if (saved && MODE_CYCLE.includes(saved)) return saved;
    // Default to vibrate if permission already granted, else off
    return typeof Notification !== 'undefined' && Notification.permission === 'granted'
      ? 'vibrate'
      : 'off';
  });
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const audioCtxRef = useRef<AudioContext | null>(null);
  const swRegRef = useRef<ServiceWorkerRegistration | null>(null);

  // Register service worker on mount
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          swRegRef.current = reg;
          console.log('[RC] Service worker registered, scope:', reg.scope);
        })
        .catch((err) => {
          console.warn('[RC] Service worker registration failed:', err);
        });
    } else {
      console.warn('[RC] Service workers not supported');
    }
  }, []);

  // Persist mode changes
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

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
          osc.frequency.value = 880;
          osc.start(ctx.currentTime);
          osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15);
          osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3);
          gain.gain.setValueAtTime(0.3, ctx.currentTime + 0.4);
          gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
          osc.stop(ctx.currentTime + 0.5);
        } else {
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

  const showNotification = useCallback(
    (title: string, body: string, urgent: boolean, currentMode: NotificationMode) => {
      const icon = urgent ? '\u26A0\uFE0F' : '\u2705';
      const iconUrl =
        'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="80" font-size="80">' +
        icon +
        '</text></svg>';

      const useVibrate = currentMode === 'vibrate' || currentMode === 'full';
      const vibrate = useVibrate
        ? urgent ? [200, 100, 200, 100, 200] : [200]
        : undefined;

      const opts: NotificationOptions & { vibrate?: number[] } = {
        body,
        icon: iconUrl,
        tag: 'rc-' + Date.now(),
        requireInteraction: urgent,
        vibrate,
        silent: currentMode === 'silent',
      };

      const reg = swRegRef.current;
      if (reg) {
        console.log('[RC] Showing notification via SW:', title, 'mode:', currentMode);
        reg.showNotification(title, opts).catch((err) => {
          console.warn('[RC] SW showNotification failed:', err);
          showFallbackNotification(title, opts);
        });
      } else {
        console.log('[RC] No SW, using fallback Notification():', title);
        showFallbackNotification(title, opts);
      }
    },
    [],
  );

  const notify = useCallback(
    (title: string, body: string, urgent: boolean, forceShow = false) => {
      const m = modeRef.current;
      if (m === 'off') {
        console.log('[RC] notify skipped: mode is off');
        return;
      }

      // Sound only in full mode
      if (m === 'full') {
        playSound(urgent);
      }

      const shouldShow = forceShow || document.hidden;
      if (shouldShow) {
        showNotification(title, body, urgent, m);
      } else {
        // Page is visible — vibrate if in vibrate/full mode
        console.log('[RC] notify: page visible, mode:', m);
        if ((m === 'vibrate' || m === 'full') && navigator.vibrate) {
          navigator.vibrate(urgent ? [200, 100, 200] : [100]);
        }
      }
    },
    [playSound, showNotification],
  );

  const toggle = useCallback(() => {
    if (typeof Notification === 'undefined') return;

    // Initialize AudioContext on user gesture
    getAudioCtx();

    const currentIdx = MODE_CYCLE.indexOf(modeRef.current);
    const nextMode = MODE_CYCLE[(currentIdx + 1) % MODE_CYCLE.length];

    // If moving from off to any active mode, ensure permission
    if (modeRef.current === 'off' && nextMode !== 'off') {
      if (Notification.permission === 'denied') return;
      if (Notification.permission !== 'granted') {
        Notification.requestPermission().then((perm) => {
          if (perm === 'granted') {
            setMode(nextMode);
          }
        });
        return;
      }
    }

    // Play confirmation chime when entering full mode
    if (nextMode === 'full') {
      playSound(false);
    }

    setMode(nextMode);
  }, [getAudioCtx, playSound]);

  return { mode, toggle, notify };
}

function showFallbackNotification(title: string, opts: NotificationOptions) {
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch (err) {
    console.warn('[RC] Fallback Notification() failed:', err);
  }
}
