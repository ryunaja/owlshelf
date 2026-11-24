import './index.css'
import './App.css'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { ProfileSelectPage } from './pages/ProfileSelectPage'
import { LocationSelectPage } from './pages/LocationSelectPage'
import { InventoryPage } from './pages/InventoryPage'
import { GlobalSearchPage } from './pages/GlobalSearchPage'
import { subscribeDbBlocked, isDbBlocked } from '@/lib/db'
import { getWorkerClient } from '@/lib/worker/client'
import { syncRuntime } from '@/lib/syncRuntime'
import { SyncPanel } from './dev/SyncPanel'
import { RoomGate } from './components/rooms/RoomGate'
import type { Profile, Location } from './types/item'

type Screen = 'profile-select' | 'location-select' | 'inventory' | 'global-search'

/** The dev sync panel is opt-in per URL (`?sync=1`), not per build mode:
 *  `vite preview` serves a production bundle, and that is where the relay and
 *  the PWA are actually exercised. */
const showSyncPanel = new URLSearchParams(window.location.search).has('sync')

/** Upgrade-blocking banner (plan §12.6): an older bundle's tab holds a v1
 *  connection it cannot close itself — ask the user to close/reload it. */
function DbBlockedBanner() {
  const blocked = useSyncExternalStore(subscribeDbBlocked, isDbBlocked, () => false)
  if (!blocked) return null
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        background: '#863bff',
        color: '#fff',
        padding: '10px 16px',
        textAlign: 'center',
        fontSize: 14,
      }}
    >
      A new version of Owlshelf is ready — close other Owlshelf tabs, then
      reload this page.
    </div>
  )
}

function App() {
  const [screen, setScreen] = useState<Screen>('profile-select')
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [activeLocation, setActiveLocation] = useState<Location | null>(null)
  const [searchOrigin, setSearchOrigin] = useState<'location-select' | 'inventory'>('location-select')

  // Plan §7.1: app open → resume the outbox and catch up every room. The
  // runtime owns one engine per room and the visibility/online/pageshow
  // listeners, so this effect is the whole boot path. It touches no React
  // state — the engines write to IndexedDB, and the pages read it through
  // `useLive` — so it cannot cascade renders.
  useEffect(() => {
    void syncRuntime.start()
    return () => syncRuntime.stop()
  }, [])

  // Plan §5 detail 1: the worker has no `document`, so the tab proxies
  // `visibilityState`. The worker disconnects ~20 s after EVERY port reports
  // hidden and reconnects on ANY visible — that is what keeps a backgrounded
  // PWA from holding a socket open on a phone. The engine lives in the worker
  // now, so this is the only thing that can tell it.
  useEffect(() => {
    const report = () => {
      void getWorkerClient().then(({ client }) => client.setVisibility(document.hidden))
    }
    document.addEventListener('visibilitychange', report)
    report()
    return () => document.removeEventListener('visibilitychange', report)
  }, [])

  const handleProfileSelect = (profile: Profile) => {
    setActiveProfile(profile)
    setScreen('location-select')
  }

  const handleLocationSelect = (location: Location) => {
    setActiveLocation(location)
    setScreen('inventory')
  }

  const handleOpenSearch = (origin: 'location-select' | 'inventory') => {
    setSearchOrigin(origin)
    setScreen('global-search')
  }

  const handleSearchBack = () => {
    setScreen(searchOrigin)
  }

  const handleSearchNavigate = (location: Location) => {
    setActiveLocation(location)
    setScreen('inventory')
  }

  let page: ReactNode
  if (screen === 'profile-select') {
    page = <ProfileSelectPage onSelect={handleProfileSelect} />
  } else if (screen === 'location-select' && activeProfile) {
    page = (
      <LocationSelectPage
        profile={activeProfile}
        onSelectLocation={handleLocationSelect}
        onBack={() => setScreen('profile-select')}
        onOpenSearch={() => handleOpenSearch('location-select')}
      />
    )
  } else if (screen === 'global-search' && activeProfile) {
    page = (
      <GlobalSearchPage
        profile={activeProfile}
        onBack={handleSearchBack}
        onNavigateToLocation={handleSearchNavigate}
      />
    )
  } else if (screen === 'inventory' && activeProfile && activeLocation) {
    page = (
      <InventoryPage
        profile={activeProfile}
        location={activeLocation}
        onBack={() => setScreen('location-select')}
        onOpenSearch={() => handleOpenSearch('inventory')}
      />
    )
  } else {
    page = <ProfileSelectPage onSelect={handleProfileSelect} />
  }

  return (
    <>
      <DbBlockedBanner />
      {page}
      {/* §6.7's two blocking prompts — a rotation notice (this shelf moved on
          without us) and a staged relay move. Mounted for the ACTIVE profile
          only, and not on the profile list: a notice for a shelf the user is
          not looking at must not block the picker. */}
      {activeProfile && screen !== 'profile-select' && (
        <RoomGate roomId={activeProfile.id} roomName={activeProfile.name} />
      )}
      {showSyncPanel && <SyncPanel />}
    </>
  )
}

export default App
