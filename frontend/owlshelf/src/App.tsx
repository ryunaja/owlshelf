import './index.css'
import './App.css'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { ProfileSelectPage } from './pages/ProfileSelectPage'
import { LocationSelectPage } from './pages/LocationSelectPage'
import { InventoryPage } from './pages/InventoryPage'
import { GlobalSearchPage } from './pages/GlobalSearchPage'
import { subscribeDbBlocked, isDbBlocked } from '@/lib/db'
import type { Profile, Location } from './types/item'

type Screen = 'profile-select' | 'location-select' | 'inventory' | 'global-search'

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
    </>
  )
}

export default App
