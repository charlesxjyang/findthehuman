const TOPICS = [
  // Opinion
  "What's the most overrated technology?",
  "What's the best decade for music?",
  "Is social media more harmful than helpful?",
  "What's the most underrated skill in the workplace?",
  "What's the worst advice people commonly give?",
  "Is it better to be a specialist or a generalist?",
  "What's the most overrated tourist destination?",
  "What's a hill you'll die on that most people disagree with?",
  "What's the best way to spend a rainy Sunday?",
  "Is cooking at home overrated or underrated?",

  // Hypothetical
  "If you could live in any historical era, which would you choose?",
  "If you could have dinner with any person, living or dead, who would it be?",
  "If you could instantly master any skill, what would you pick?",
  "If you could redesign the education system from scratch, what would it look like?",
  "If you could live in any fictional universe, which would you choose?",
  "If you were given $10 million but had to spend it in 24 hours, what would you do?",
  "If you could swap lives with anyone for a week, who would it be?",
  "If you could eliminate one minor inconvenience from your life forever, what would it be?",
  "If you had to eat only one cuisine for the rest of your life, which would it be?",
  "If you could witness any event in history firsthand, what would you choose?",

  // Debate
  "Is remote work better than office work?",
  "Should college education be free?",
  "Are electric cars actually better for the environment?",
  "Is it ethical to eat meat?",
  "Should voting be mandatory?",
  "Is it better to rent or buy a home?",
  "Should there be a universal basic income?",
  "Is technology making us more or less connected?",
  "Should AI art be considered real art?",
  "Is cancel culture a net positive or negative for society?",

  // Scenarios
  "You're stranded on a desert island — you can bring 3 items. What do you bring?",
  "You wake up tomorrow as the president — what's the first thing you do?",
  "Your house is on fire — what non-living thing do you save?",
  "You can only use one app on your phone for a month — which one?",
  "You have to teach a class on anything — what do you teach?",

  // Fun/creative
  "What's the most useless superpower you can think of?",
  "Describe your ideal weekend in 3 words.",
  "What conspiracy theory is the most entertaining?",
  "What would your autobiography be titled?",
  "What's a trend you never understood?",
  "If your life had a theme song, what would it be?",
  "What's the most creative excuse you've ever made up?",
];

import { getRedis } from './redis.js';

const RECENT_KEY = 'topics:recent';
const RECENT_SIZE = 40; // Don't repeat last 40 topics

export async function getRandomTopic(): Promise<string> {
  try {
    const redis = getRedis();
    const recent = await redis.lrange(RECENT_KEY, 0, RECENT_SIZE - 1);
    const recentSet = new Set(recent);

    // Filter to topics not recently used
    let available = TOPICS.filter((t) => !recentSet.has(t));
    if (available.length === 0) {
      // All topics used recently — clear and start fresh
      await redis.del(RECENT_KEY);
      available = TOPICS;
    }

    const topic = available[Math.floor(Math.random() * available.length)];

    // Track as recently used
    await redis.lpush(RECENT_KEY, topic);
    await redis.ltrim(RECENT_KEY, 0, RECENT_SIZE - 1);

    return topic;
  } catch {
    // Fallback if Redis unavailable
    return TOPICS[Math.floor(Math.random() * TOPICS.length)];
  }
}

export { TOPICS };
