// Popup. Sends a message to the content script and renders the numbers it sends back.
//
// Every line in the report is a measurement taken from the live page. Nothing here is a
// reassurance: if the page still has failing text after the reflow, the popup says so in red
// rather than reporting a success it did not observe.

function chosenFace() {
  const picked = document.querySelector('input[name=face]:checked');
  return picked ? picked.value : 'atkinson';
}

function row(dl, label, value, klass) {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = value;
  if (klass) dd.className = klass;
  dl.append(dt, dd);
}

function render(result) {
  const box = document.getElementById('report');
  const dl = document.getElementById('numbers');
  dl.textContent = '';
  const { before, after } = result;
  const fmt = (n) => (n === null || n === undefined ? 'n/a' : `${n.toFixed(2)}:1`);

  row(dl, 'Text runs measured', String(after.textRuns));
  row(dl, 'Failing contrast before', String(before.failingContrast), before.failingContrast ? 'bad' : 'good');
  row(dl, 'Failing contrast now', String(after.failingContrast), after.failingContrast ? 'bad' : 'good');
  row(dl, 'Lowest contrast before', fmt(before.minContrast));
  row(dl, 'Lowest contrast now', fmt(after.minContrast), (after.minContrast || 0) >= 4.5 ? 'good' : 'bad');
  row(dl, 'Justified lines removed', String(before.justifiedRuns - after.justifiedRuns));
  row(dl, 'Paragraphs shaded', String(result.shaded));
  row(dl, 'Reading order, inverted pairs', `${before.readingOrder.inversions} to ${after.readingOrder.inversions}`);
  row(dl, 'Images needing a description', String(after.images.needsHuman), after.images.needsHuman ? 'bad' : 'good');

  const caveats = [];
  if (after.failingContrast > 0) {
    caveats.push(`${after.failingContrast} run(s) still fail. The page sets those colours in a way this extension could not override.`);
  }
  if (after.images.needsHuman > 0) {
    caveats.push(`${after.images.needsHuman} image(s) have no usable alt text. No description was invented for them, because this extension cannot see the picture. Each one is flagged in the page.`);
  }
  if (after.readingOrder.inversions > 0) {
    caveats.push(`${after.readingOrder.inversions} pair(s) of blocks still read in a different order on screen than in the markup.`);
  }
  document.getElementById('caveat').textContent = caveats.length
    ? caveats.join(' ')
    : 'Every text run on this page now meets 4.5:1, and every image has a description or is marked decorative.';
  box.hidden = false;
}

async function send(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('no active tab');
  return chrome.tabs.sendMessage(tab.id, message);
}

document.getElementById('apply').addEventListener('click', async () => {
  try {
    const reply = await send({ type: 'legible-apply', options: { face: chosenFace() } });
    if (reply && reply.ok) render(reply.result);
    else throw new Error('the page did not answer');
  } catch (err) {
    document.getElementById('report').hidden = false;
    document.getElementById('caveat').textContent = `Could not reach the page: ${err.message}. Chrome blocks extensions on its own pages and on the Web Store.`;
  }
});

document.getElementById('revert').addEventListener('click', async () => {
  try {
    await send({ type: 'legible-revert' });
    document.getElementById('report').hidden = true;
  } catch (err) {
    document.getElementById('caveat').textContent = `Could not reach the page: ${err.message}.`;
  }
});
