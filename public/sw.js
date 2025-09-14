// Enhanced Service Worker for background functionality and location tracking
const CACHE_NAME = 'tripgo-v2';
const urlsToCache = [
  '/',
  '/index.html',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

// Install event
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Service Worker: Caching files');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
        console.log('Service Worker: Installed');
        return self.skipWaiting();
      })
  );
});

// Activate event
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('Service Worker: Activated');
      return self.clients.claim();
    })
  );
});

// Fetch event with enhanced caching strategy
self.addEventListener('fetch', (event) => {
  // Handle API requests differently from static assets
  if (event.request.url.includes('/api/')) {
    // For API requests, always try network first, then cache
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Clone the response before caching
          const responseClone = response.clone();
          
          // Cache successful API responses (optional)
          if (response.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          
          return response;
        })
        .catch(() => {
          // If network fails, try cache
          return caches.match(event.request);
        })
    );
  } else {
    // For static assets, try cache first, then network
    event.respondWith(
      caches.match(event.request)
        .then((response) => {
          return response || fetch(event.request);
        })
    );
  }
});

// Background sync for location data
self.addEventListener('sync', (event) => {
  console.log('Service Worker: Background sync triggered:', event.tag);
  
  if (event.tag === 'background-location-sync') {
    event.waitUntil(doBackgroundLocationSync());
  } else if (event.tag === 'trip-data-sync') {
    event.waitUntil(syncTripData());
  }
});

// Enhanced background location sync
async function doBackgroundLocationSync() {
  try {
    console.log('Service Worker: Background location sync started');
    
    // Check if we have an active trip
    const clients = await self.clients.matchAll();
    
    if (clients.length > 0) {
      // Send message to active clients to continue location tracking
      clients.forEach(client => {
        client.postMessage({
          type: 'BACKGROUND_LOCATION_UPDATE',
          timestamp: Date.now()
        });
      });
    }
    
    // If geolocation is available in service worker context
    if ('geolocation' in navigator) {
      try {
        const position = await getCurrentPosition();
        console.log('Service Worker: Got background location', position.coords);
        
        // Store location data locally for sync when app becomes active
        await storeLocationData({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          timestamp: Date.now(),
          accuracy: position.coords.accuracy
        });
        
      } catch (error) {
        console.error('Service Worker: Background location failed:', error);
      }
    }
    
  } catch (error) {
    console.error('Service Worker: Background sync failed:', error);
  }
}

// Sync trip data when online
async function syncTripData() {
  try {
    console.log('Service Worker: Syncing trip data');
    
    // Get stored offline trip data
    const storedData = await getStoredTripData();
    
    if (storedData && storedData.length > 0) {
      // Send stored data to server
      for (const tripData of storedData) {
        try {
          const response = await fetch('/api/trip/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tripData)
          });
          
          if (response.ok) {
            await removeStoredTripData(tripData.id);
          }
        } catch (error) {
          console.error('Service Worker: Failed to sync trip data:', error);
        }
      }
    }
    
  } catch (error) {
    console.error('Service Worker: Trip data sync failed:', error);
  }
}

// Helper function to get current position in service worker
function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    
    navigator.geolocation.getCurrentPosition(
      resolve,
      reject,
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000,
        ...options
      }
    );
  });
}

// Store location data in IndexedDB
async function storeLocationData(locationData) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['locations'], 'readwrite');
    const store = transaction.objectStore('locations');
    
    await store.add({
      ...locationData,
      id: Date.now()
    });
    
    console.log('Service Worker: Location data stored');
  } catch (error) {
    console.error('Service Worker: Failed to store location data:', error);
  }
}

// Get stored trip data
async function getStoredTripData() {
  try {
    const db = await openDB();
    const transaction = db.transaction(['tripData'], 'readonly');
    const store = transaction.objectStore('tripData');
    
    return await store.getAll();
  } catch (error) {
    console.error('Service Worker: Failed to get stored trip data:', error);
    return [];
  }
}

// Remove stored trip data after successful sync
async function removeStoredTripData(id) {
  try {
    const db = await openDB();
    const transaction = db.transaction(['tripData'], 'readwrite');
    const store = transaction.objectStore('tripData');
    
    await store.delete(id);
    console.log('Service Worker: Removed synced trip data:', id);
  } catch (error) {
    console.error('Service Worker: Failed to remove trip data:', error);
  }
}

// Open IndexedDB
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('TripGoStore', 1);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      
      // Create object stores
      if (!db.objectStoreNames.contains('locations')) {
        db.createObjectStore('locations', { keyPath: 'id' });
      }
      
      if (!db.objectStoreNames.contains('tripData')) {
        db.createObjectStore('tripData', { keyPath: 'id' });
      }
    };
  });
}

// Handle messages from main thread
self.addEventListener('message', (event) => {
  console.log('Service Worker: Received message:', event.data);
  
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (event.data && event.data.type === 'START_BACKGROUND_TRACKING') {
    // Register background sync
    self.registration.sync.register('background-location-sync');
  } else if (event.data && event.data.type === 'STOP_BACKGROUND_TRACKING') {
    // Background tracking stopped - cleanup if needed
    console.log('Service Worker: Background tracking stopped');
  }
});

// Enhanced push notifications for trip updates
self.addEventListener('push', (event) => {
  let options = {
    body: 'TripGo is tracking your trip in the background',
    icon: '/icon-192x192.png',
    badge: '/icon-72x72.png',
    vibrate: [100, 50, 100],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: 1
    },
    actions: [
      {
        action: 'open',
        title: 'Open App',
        icon: '/icon-72x72.png'
      },
      {
        action: 'close',
        title: 'Dismiss',
        icon: '/icon-72x72.png'
      }
    ]
  };

  if (event.data) {
    try {
      const pushData = event.data.json();
      options = { ...options, ...pushData };
    } catch (error) {
      console.error('Service Worker: Error parsing push data:', error);
    }
  }

  event.waitUntil(
    self.registration.showNotification('TripGo', options)
  );
});

// Handle notification clicks with enhanced functionality
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'open') {
    event.waitUntil(
      clients.matchAll({ type: 'window' }).then((clientList) => {
        // If app is already open, focus it
        for (const client of clientList) {
          if (client.url === '/' && 'focus' in client) {
            return client.focus();
          }
        }
        
        // Otherwise, open new window
        if (clients.openWindow) {
          return clients.openWindow('/');
        }
      })
    );
  } else if (event.action === 'close') {
    // Just close the notification (already handled above)
    return;
  } else {
    // Default action - open app
    event.waitUntil(
      clients.openWindow('/')
    );
  }
});
