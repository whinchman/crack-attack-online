import CrackAttackGame from "./game/CrackAttackGame";

export default function Home() {
  return (
    <main className="port-page">
      <CrackAttackGame />

      <section className="player-guide" aria-labelledby="guide-heading">
        <div className="guide-heading">
          <span>How to play</span>
          <h2 id="guide-heading">Make matches. Keep the stack down.</h2>
        </div>
        <div className="guide-copy">
          <article>
            <h3>Build lines</h3>
            <p>
              Move the two-block cursor and swap neighboring pieces. Match three or more of the same
              color horizontally or vertically before the rising stack reaches the top. On a touch
              screen, swipe a block sideways to swap it directly, or glide on the move pad without
              hunting for individual arrows. Raise brings in the next row sooner.
            </p>
          </article>
          <article>
            <h3>Set up chains</h3>
            <p>
              Keep swapping while a line breaks to prepare your next move. Clear blocks touching
              garbage to reveal the colors inside, then arrange the stack below before they fall.
              Only lines made by blocks set falling by the previous clear extend the combo.
            </p>
          </article>
        </div>
      </section>

      <footer className="port-footer">
        <p>
          A GPL-2.0-or-later derivative of <a href="https://www.nongnu.org/crack-attack/">Crack Attack!</a>,
          originally created by Daniel R. Nelson and contributors. Built on the{' '}
            <a href="https://github.com/leifkb/crack-attack-browser">browser port by leifkb</a>,
            with online play added. Original artwork is redistributed under the
            project&apos;s license.
        </p>
        <div>
          <a href="https://github.com/gnu-lorien/crack-attack">Original source</a>
          <a href="./COPYING.txt">License</a>
        </div>
      </footer>
    </main>
  );
}
