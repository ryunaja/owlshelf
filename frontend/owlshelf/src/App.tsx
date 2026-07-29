import './index.css'
import './App.css'
import { useState } from 'react'
import { ProfileSelectPage } from './pages/ProfileSelectPage'
import { LocationSelectPage } from './pages/LocationSelectPage'
import { InventoryPage } from './pages/InventoryPage'
import { GlobalSearchPage } from './pages/GlobalSearchPage'
import type { Profile, Location } from './types/item'

type Screen = 'profile-select' | 'location-select' | 'inventory' | 'global-search'

function App() {
  const [screen, setScreen] = useState<Screen>('profile-select')
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [activeLocation, setActiveLocation] = useState<Location | null>(null)
  // Track where we came from so global-search "back" goes to the right screen
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

  if (screen === 'profile-select') {
    return <ProfileSelectPage onSelect={handleProfileSelect} />
  }

  if (screen === 'location-select' && activeProfile) {
    return (
      <LocationSelectPage
        profile={activeProfile}
        onSelectLocation={handleLocationSelect}
        onBack={() => setScreen('profile-select')}
        onOpenSearch={() => handleOpenSearch('location-select')}
      />
    )
  }

  if (screen === 'global-search' && activeProfile) {
    return (
      <GlobalSearchPage
        profile={activeProfile}
        onBack={handleSearchBack}
        onNavigateToLocation={handleSearchNavigate}
      />
    )
  }

  if (screen === 'inventory' && activeProfile && activeLocation) {
    return (
      <InventoryPage
        profile={activeProfile}
        location={activeLocation}
        onBack={() => setScreen('location-select')}
        onOpenSearch={() => handleOpenSearch('inventory')}
      />
    )
  }

  return <ProfileSelectPage onSelect={handleProfileSelect} />
}

export default App
