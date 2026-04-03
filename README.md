# Fancy Pics

A 3D interactive photo gallery disguised as a glowing pearl inside a particle shell. Control the shell with hand gestures through your webcam — open it to reveal your photos, scatter the particles into a comet trail, or zoom in to browse pictures one by one.

Built with Three.js, React, MediaPipe, and custom GLSL shaders.

## Features

- **Particle Shell** — Thousands of instanced particles form a shell shape using custom vertex/fragment shaders with a texture atlas (stars, circles, sparkles, flowers)
- **Glowing Pearl** — A physically-based rendered pearl with emissive glow sits at the center, pulsing with bloom post-processing
- **Hand Gesture Control** — MediaPipe Hands tracks your webcam input in real-time to control the scene:
  - **Open hand** — Opens the shell to reveal photos inside
  - **Closed fist** — Closes the shell
  - **Victory / Peace sign** — Scatters particles into a comet trail that follows your hand
  - **Pinch** — Zooms into photos one by one for close-up viewing
  - **Hand position** — Moves and rotates the shell in 3D space
- **Photo Gallery** — Upload photos that float inside the opened shell, with smooth GSAP animations for zooming, fading, and transitions
- **Comet Trail** — When scattered, all particles merge into a single comet with a dynamic tail that reacts to your hand movement direction
- **Bloom Post-Processing** — Unreal Bloom pass on particles and pearl, with a separate render pass for photos to keep them clean
- **Orbit Controls** — Mouse/touch orbit when hands aren't detected

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React 19 + TypeScript |
| 3D Engine | Three.js |
| Hand Tracking | MediaPipe Hands |
| Animation | GSAP |
| Shaders | Custom GLSL (vertex + fragment) |
| Styling | Tailwind CSS 4 |
| Build | Vite |
| AI (optional) | Google Gemini API |

## Getting Started

### Prerequisites

- Node.js (v18+)
- A webcam (for hand gesture control)

### Install & Run

```bash
# Clone the repo
git clone https://github.com/Kanye-Est/Fancy-pics.git
cd Fancy-pics

# Install dependencies
npm install

# Start the dev server
npm run dev
```

The app runs at `http://localhost:3000`.

### Environment Variables (Optional)

Copy the example and fill in your keys if you want AI features:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Google Gemini API key |
| `APP_URL` | Hosted app URL (for OAuth/callbacks) |

## Usage

1. **Allow camera access** when prompted
2. Show your hand to the webcam — the shell will follow your hand position
3. **Open your hand** to open the shell and see the pearl transform into floating photos
4. **Make a peace sign** to scatter particles into a comet trail
5. **Pinch** to cycle through and zoom into individual photos
6. **Close your fist** to close the shell back up
7. Upload photos using the UI to add them to your collection

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server on port 3000 |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm run lint` | Type-check with TypeScript |
| `npm run clean` | Remove dist folder |

## License

[MIT](LICENSE) — Shiyu Kan
