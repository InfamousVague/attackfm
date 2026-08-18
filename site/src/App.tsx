import { Footer } from './components/Footer.tsx';
import { Nav } from './components/Nav.tsx';
import { Downloads } from './sections/Downloads.tsx';
import { Gallery } from './sections/Gallery.tsx';
import { Get } from './sections/Get.tsx';
import { Hero } from './sections/Hero.tsx';
import { Booth, Everywhere, Library, Playing } from './sections/Showcase.tsx';
import { Yours } from './sections/Yours.tsx';

export function App() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Library />
        <Booth />
        <Playing />
        <Everywhere />
        <Gallery />
        <Yours />
        <Downloads />
        <Get />
      </main>
      <Footer />
    </>
  );
}
