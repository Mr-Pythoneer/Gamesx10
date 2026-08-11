// Lexicon — internet-slang/meme word allowlist, merged into the system dictionary at
// load time (see words.js). The base dictionary comes from /usr/share/dict/words, which
// is stuffed with archaic English ("abaction", "zymurgy") but has none of the words an
// actual player reaches for — this list closes that gap in the other direction.
//
// Hand-curated, lowercase, 3-8 letters (MIN_WORD..MAX_WORD), no duplicates of anything
// already in the system dictionary (a duplicate here is harmless, just wasted bytes).
export const SLANG = [
  // classic internet
  'lol', 'lmao', 'rofl', 'omg', 'wtf', 'brb', 'afk', 'idk', 'imo', 'imho',
  'tbh', 'irl', 'diy', 'faq', 'fyi', 'btw', 'smh', 'tfw', 'yolo', 'fomo',
  // meme/slang adjectives & nouns
  'meme', 'memes', 'based', 'cringe', 'sus', 'bruh', 'yeet', 'simp', 'stan',
  'vibe', 'vibes', 'salty', 'flex', 'woke', 'lit', 'extra', 'shade', 'tea',
  'drip', 'goat', 'rekt', 'noob', 'pwned', 'troll', 'trolls', 'trolled',
  'ghosted', 'ghost', 'ghosting', 'catfish', 'thirsty', 'petty', 'basic',
  'savage', 'lowkey', 'hangry', 'sksksk', 'yikes', 'oof', 'welp', 'meh',
  'derp', 'facepalm', 'spoiler', 'binge', 'bingeing',
  // gaming/streaming
  'nerf', 'buff', 'op', 'gg', 'ggwp', 'afk', 'lag', 'laggy', 'grind',
  'grindy', 'speedrun', 'respawn', 'loot', 'mob', 'boss', 'pwn', 'camping',
  'smurf', 'toxic', 'meta', 'nooby', 'stream', 'streamer', 'streaming',
  'twitch', 'stonks', 'poggers', 'pog', 'esports',
  // texting/chat shorthand
  'lolz', 'nvm', 'ikr', 'ily', 'rip', 'gtg', 'ttyl', 'wyd', 'hbu', 'sm',
  'ftw', 'nsfw', 'dm', 'dms', 'pm', 'pms', 'lmk', 'jk', 'sry', 'plz',
  'thx', 'ya', 'yeah', 'nah', 'welp',
  // modern nouns/adjectives that a 1913-vintage system dictionary won't have
  'app', 'apps', 'blog', 'blogs', 'blogger', 'wifi', 'email', 'emoji',
  'emojis', 'selfie', 'selfies', 'hashtag', 'unfriend', 'podcast',
  'vlog', 'vlogger', 'viral', 'trending', 'spam', 'spammy',
  'phishing', 'malware', 'firmware', 'software', 'hardware', 'byte', 'bytes',
  'gif', 'gifs', 'jpeg', 'jpg', 'png', 'url', 'urls', 'login', 'logout',
  'signup', 'reboot', 'startup', 'startups', 'unicorn',
];
