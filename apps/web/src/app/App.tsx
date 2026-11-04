import { HashRouter, MemoryRouter, Route, Routes } from 'react-router-dom';
import { CreateTripPage } from '../features/create-trip/CreateTripPage';
import { ExplorePage } from '../features/explore/ExplorePage';
import { HomePage } from '../features/home/HomePage';
import { PassportPage } from '../features/passport/PassportPage';
import { TripPage } from '../features/trip/TripPage';
import { ServicesProvider } from './services';

// Hash routes on a real host; in-memory routes for the embedded preview (VITE_ROUTER=memory).
const Router = import.meta.env.VITE_ROUTER === 'memory' ? MemoryRouter : HashRouter;

export function App() {
  return (
    <ServicesProvider>
      <Router>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/plan/new" element={<CreateTripPage />} />
          <Route path="/trips/:id" element={<TripPage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/passport" element={<PassportPage />} />
          <Route path="*" element={<HomePage />} />
        </Routes>
      </Router>
    </ServicesProvider>
  );
}
