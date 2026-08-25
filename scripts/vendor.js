/* Copies Locomotive Scroll's dist files into public/vendor so the landing page
   serves them from our own origin instead of a CDN. Runs on postinstall. */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'locomotive-scroll', 'dist');
const dest = path.join(__dirname, '..', 'public', 'vendor');
const files = ['locomotive-scroll.min.js', 'locomotive-scroll.min.css'];

try {
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
  console.log('vendored locomotive-scroll →  public/vendor');
} catch (err) {
  // A missing vendor copy only degrades the landing page, so don't fail the build.
  console.warn('could not vendor locomotive-scroll:', err.message);
}
