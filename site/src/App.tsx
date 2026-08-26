import { Footer } from './components/Footer.tsx';
import { Nav } from './components/Nav.tsx';
import { Booth } from './sections/Booth.tsx';
import { Downloads } from './sections/Downloads.tsx';
import { Everywhere } from './sections/Everywhere.tsx';
import { Hero } from './sections/Hero.tsx';
import { Yours } from './sections/Yours.tsx';

/**
 * Five sections, and every screen on the page is the app itself.
 *
 * The previous page had nine, and most of the extra four were the same
 * screenshots shown again: a Gallery whose six frames duplicated the shots
 * above it, a Library section and a Now Playing section making one argument
 * between them, and a Get section holding a single install line that belongs
 * with the server it installs. What is left is one claim per section, each
 * with a live frame standing behind it - see components/Frame.tsx.
 */
export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Booth />
        <Everywhere />
        <Yours />
        <Downloads />
      </main>
      <Footer />
    </>
  );
}
