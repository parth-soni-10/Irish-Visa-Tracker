(function() {
        function urlBase64ToUint8Array(base64String) {
          var padding = '='.repeat((4 - base64String.length % 4) % 4);
          var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
          var rawData = window.atob(base64);
          var outputArray = new Uint8Array(rawData.length);
          for (var i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
          return outputArray;
        }
        function arrayBufferToBase64(buffer) {
          if (!buffer) return '';
          var bytes = new Uint8Array(buffer);
          var binary = '';
          for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        }
        async function getVapidKey() {
          if (window.__vapidPublicKey) return window.__vapidPublicKey;
          var response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
          var config = response.ok ? await response.json() : null;
          if (config && config.vapid_public_key) window.__vapidPublicKey = config.vapid_public_key;
          return window.__vapidPublicKey || '';
        }
        window.enablePushNotifications = async function(appNumber, embassy) {
          if (!appNumber) return { ok: false, error: 'Add a watch first.' };
          if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
            return { ok: false, error: 'This browser does not support Web Push.' };
          }
          try {
            var permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
            if (permission !== 'granted') return { ok: false, error: 'Notification permission was not granted.' };
            var key = await getVapidKey();
            if (!key) return { ok: false, error: 'Push is not configured on this deployment.' };
            var registration = await navigator.serviceWorker.ready;
            var subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
              subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(key)
              });
            }
            var response = await fetch('/api/user/push/subscribe', {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: subscription.endpoint,
                p256dh: arrayBufferToBase64(subscription.getKey('p256dh')),
                auth: arrayBufferToBase64(subscription.getKey('auth')),
                application_number: appNumber,
                embassy_slug: embassy
              })
            });
            var data = await response.json().catch(function() { return {}; });
            return { ok: response.ok, error: data.error || '' };
          } catch (error) {
            return { ok: false, error: error.message || 'Could not enable browser notifications.' };
          }
        };
        fetch('/api/config', { headers: { Accept: 'application/json' } })
          .then(function(response) { return response.ok ? response.json() : null; })
          .then(function(config) {
            if (config && config.vapid_public_key) window.__vapidPublicKey = config.vapid_public_key;
          })
          .catch(function() { /* push is optional */ });
      })();
