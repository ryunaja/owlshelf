import './index.css'
import './App.css'
import { useState } from 'react'
import { ProfileSelectPage } from './pages/ProfileSelectPage'
import { LocationSelectPage } from './pages/LocationSelectPage'
import { InventoryPage } from './pages/InventoryPage'
import type { Profile, Location } from './types/item'

type Screen = 'profile-select' | 'location-select' | 'inventory'

function App() {
  const [screen, setScreen] = useState<Screen>('profile-select')
  const [activeProfile, setActiveProfile] = useState<Profile | null>(null)
  const [activeLocation, setActiveLocation] = useState<Location | null>(null)

  const handleProfileSelect = (profile: Profile) => {
    setActiveProfile(profile)
    setScreen('location-select')
  }

  const handleLocationSelect = (location: Location) => {
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
      />
    )
  }

  if (screen === 'inventory' && activeProfile && activeLocation) {
    return (
      <InventoryPage
        profile={activeProfile}
        location={activeLocation}
        onBack={() => setScreen('location-select')}
      />
    )
  }

  return <ProfileSelectPage onSelect={handleProfileSelect} />
}

export default App
