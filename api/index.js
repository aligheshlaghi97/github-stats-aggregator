const axios = require("axios");
const { createClient } = require("redis");

// IMPORTANT: This GITHUB_TOKEN will be provided by Vercel's environment variables.
// It will NOT be committed to your Git repository.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

// In-memory cache for this running instance. Redis keeps the same number for 90 days.
const highestStarsCache = {};
const STAR_CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;
const STAR_FETCH_TIMEOUT_MS = 2500;

let redisClient = null;
let redisConnecting = null;

// Vercel injects REDIS_URL when the Redis database is connected to the project.
async function getRedisClient() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient && redisClient.isOpen) return redisClient;
  if (redisConnecting) return redisConnecting;

  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 2000 },
    disableOfflineQueue: true,
  });
  client.on("error", (error) => {
    console.warn("Redis error:", error.message);
  });

  redisConnecting = client
    .connect()
    .then(() => {
      redisClient = client;
      console.log("Redis connected");
      return client;
    })
    .catch((error) => {
      console.warn("Redis connection failed:", error.message);
      return null;
    })
    .finally(() => {
      redisConnecting = null;
    });

  return redisConnecting;
}

// Initialize cache from environment variables if available
// Format: HIGHEST_STARS_{username}_{org}=value
function initializeCacheFromEnv() {
  Object.keys(process.env).forEach((key) => {
    if (key.startsWith("HIGHEST_STARS_")) {
      const cacheKey = key.replace("HIGHEST_STARS_", "");
      const value = parseInt(process.env[key], 10);
      if (!isNaN(value) && value > 0) {
        highestStarsCache[cacheKey] = value;
        console.log(`📦 Initialized cache from env: ${cacheKey} = ${value}`);
      }
    }
  });
}

// Initialize on module load
initializeCacheFromEnv();

function parseStars(value) {
  const n = typeof value === "number" ? value : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The number we keep is the higher of memory and Redis. A lower read never replaces it.
async function getCachedStars(cacheKey) {
  let best = parseStars(highestStarsCache[cacheKey]);
  const redis = await getRedisClient();

  if (redis) {
    try {
      const stored = parseStars(await redis.get(`stars:${cacheKey}`));
      if (stored > best) best = stored;
    } catch (error) {
      console.warn(`Redis read error for ${cacheKey}:`, error.message);
    }
  }

  best = Math.max(best, parseStars(process.env[`HIGHEST_STARS_${cacheKey}`]));
  if (best > 0) highestStarsCache[cacheKey] = best;
  return best;
}

async function setCachedStars(cacheKey, value) {
  const current = Math.max(
    parseStars(highestStarsCache[cacheKey]),
    await getCachedStars(cacheKey)
  );
  if (!(value > current)) return current;

  highestStarsCache[cacheKey] = value;
  const redis = await getRedisClient();
  if (!redis) return value;

  try {
    await redis.set(`stars:${cacheKey}`, String(value), { EX: STAR_CACHE_TTL_SECONDS });
    console.log(`Saved star total in Redis for 90 days: ${cacheKey} = ${value}`);
  } catch (error) {
    console.warn(`Redis write error for ${cacheKey}:`, error.message);
  }
  return value;
}

// Count public stars from GitHub itself.
// Returns null when the request fails, so a failure is not treated as zero stars.
async function countPublicStars(username, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "github-stats-aggregator-v1",
  };
  if (token) headers.Authorization = `bearer ${token}`;

  let total = 0;
  for (let page = 1; page <= 2; page++) {
      const response = await axios.get(
        `https://api.github.com/users/${encodeURIComponent(username)}/repos`,
        {
          headers,
          timeout: STAR_FETCH_TIMEOUT_MS,
          params: { per_page: 100, page, type: "owner" },
        }
      );
    const repos = response.data;
    if (!Array.isArray(repos)) return null;

    for (const repo of repos) {
      if (!repo || repo.private) continue;
      total += Number(repo.stargazers_count) || 0;
    }
    if (repos.length < 100) return total;
  }
  return total;
}

async function fetchStarsFromGitHub(username) {
  try {
    const total = await countPublicStars(username, GITHUB_TOKEN);
    if (total !== null) return total;
  } catch (error) {
    console.error(
      `GitHub star count failed for ${username}:`,
      error.response ? error.response.status : error.message
    );
  }

  if (!GITHUB_TOKEN) return null;
  try {
    return await countPublicStars(username, null);
  } catch (error) {
    console.error(
      `Public GitHub star count failed for ${username}:`,
      error.response ? error.response.status : error.message
    );
    return null;
  }
}

// The external counter often answers 0 when it is rate-limited, so only a positive count is usable.
async function fetchStarsFromExternalAPI(username) {
  try {
    const response = await axios.get(
      `https://api.github-star-counter.workers.dev/user/${encodeURIComponent(username)}`,
      { timeout: STAR_FETCH_TIMEOUT_MS }
    );
    const stars = response.data && response.data.stars;
    if (typeof stars === "number" && stars > 0) return stars;
    return null;
  } catch (error) {
    console.error(`External star count failed for ${username}:`, error.message);
    return null;
  }
}

// Ask both sources at once. A failed source is ignored. The higher real count wins.
async function fetchBestStars(username) {
  const [externalStars, githubStars] = await Promise.all([
    fetchStarsFromExternalAPI(username),
    fetchStarsFromGitHub(username),
  ]);
  const found = [externalStars, githubStars].filter((value) => typeof value === "number");
  if (found.length === 0) {
    console.warn(`No star count for ${username}`);
    return null;
  }
  const best = Math.max(...found);
  console.log(
    `Stars for ${username}: external ${externalStars}, github ${githubStars}, using ${best}`
  );
  return best;
}

// Function to fetch personal contributions from GitHub GraphQL API (authenticated)
// This includes both public and private repository contributions
async function fetchPersonalContributionsFromGitHub(username) {
  if (!GITHUB_TOKEN) {
    console.error(
      "GITHUB_TOKEN is not set. Cannot fetch personal contributions from GitHub."
    );
    return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
  }

  const headers = {
    Authorization: `bearer ${GITHUB_TOKEN}`,
    "Content-Type": "application/json",
    "User-Agent": "github-stats-aggregator-v1",
  };

  // Calculate last 365 days instead of current year
  const now = new Date();
  const endDate = now.toISOString();
  const startDate = new Date(
    now.getTime() - 365 * 24 * 60 * 60 * 1000
  ).toISOString();

  // First try to get public contributions
  const publicQuery = `
        query ($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
                contributionsCollection(from: $from, to: $to) {
                    totalCommitContributions
                    totalPullRequestContributions
                    totalIssueContributions
                    totalRepositoriesWithContributedCommits
                }
            }
            rateLimit {
                remaining
                resetAt
            }
        }
    `;

  // Then try to get private contributions
  const privateQuery = `
        query ($login: String!, $from: DateTime!, $to: DateTime!) {
            user(login: $login) {
                contributionsCollection(from: $from, to: $to, includePrivate: true) {
                    totalCommitContributions
                    totalPullRequestContributions
                    totalIssueContributions
                    totalRepositoriesWithContributedCommits
                }
            }
            rateLimit {
                remaining
                resetAt
            }
        }
    `;

  const variables = { login: username, from: startDate, to: endDate };

  try {
    // Try private contributions first (this is what we want)
    let response;
    let isPrivateData = false;

    try {
      console.log("Attempting to fetch private contributions...");
      response = await axios.post(
        GITHUB_GRAPHQL_ENDPOINT,
        { query: privateQuery, variables },
        { headers }
      );

      if (
        response.data.data &&
        response.data.data.user &&
        response.data.data.user.contributionsCollection
      ) {
        console.log("Successfully fetched private contributions!");
        isPrivateData = true;
      } else {
        throw new Error("Private data not available");
      }
    } catch (privateError) {
      console.log(
        "Private contributions failed, trying public contributions..."
      );
      console.log("Private error:", privateError.message);

      try {
        response = await axios.post(
          GITHUB_GRAPHQL_ENDPOINT,
          { query: publicQuery, variables },
          { headers }
        );
        console.log("Fetched public contributions as fallback");
      } catch (publicError) {
        console.error(
          "Both private and public queries failed:",
          publicError.message
        );
        throw publicError;
      }
    }

    if (response.data.errors) {
      console.error(
        "GraphQL errors for personal contributions:",
        response.data.errors
      );
      response.data.errors.forEach((err) => console.error(err.message));
      return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
    }

    const userData = response.data.data.user;
    if (!userData || !userData.contributionsCollection) {
      console.warn(`No contribution data found for user ${username}.`);
      return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
    }

    const contributions = userData.contributionsCollection;

    console.log(
      `Fetched ${
        isPrivateData ? "PRIVATE" : "PUBLIC"
      } contributions for ${username}:`,
      {
        commits: contributions.totalCommitContributions,
        prs: contributions.totalPullRequestContributions,
        issues: contributions.totalIssueContributions,
        contributedTo: contributions.totalRepositoriesWithContributedCommits,
      }
    );

    return {
      totalCommits: contributions.totalCommitContributions,
      totalPRs: contributions.totalPullRequestContributions,
      totalIssues: contributions.totalIssueContributions,
      contributedTo: contributions.totalRepositoriesWithContributedCommits,
    };
  } catch (error) {
    console.error(
      `Error fetching personal contributions for ${username}:`,
      error.response ? error.response.data : error.message
    );
    if (
      error.response &&
      (error.response.status === 401 || error.response.status === 403)
    ) {
      console.error(
        "Authentication failed or Rate Limit Exceeded for GraphQL. Check GITHUB_TOKEN and its permissions."
      );
    }
    return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
  }
}

// Function to generate the SVG image
function generateSVG(data) {
  const {
    totalStars,
    totalCommits,
    totalPRs,
    totalIssues,
    totalContributedTo,
  } = data;

  const textColor = "#c9d1d9";
  const iconColor = "#58a6ff";
  const bgColor = "#0d1117";
  const borderColor = "#30363d";

  const width = 450;
  const height = 240;
  const padding = 20;
  const lineHeight = 22;

  // Calculate proper spacing for equal top and bottom margins
  const titleHeight = 25; // Space for title
  const contentHeight = 5 * lineHeight; // 5 rows of content
  const totalContentHeight = titleHeight + contentHeight;
  const availableSpace = height - totalContentHeight;
  const topMargin = Math.floor(availableSpace / 2); // Truly equal spacing

  const createRow = (label, value, y, icon) => `
        <g transform="translate(${padding}, ${y})">
            <text x="0" y="0" fill="${iconColor}" font-size="14">${icon}</text>
            <text x="25" y="0" fill="${textColor}" font-size="14" font-weight="bold">${label}:</text>
            <text x="${
              width - padding - 50
            }" y="0" fill="${textColor}" font-size="14" text-anchor="end">${value}</text>
        </g>
    `;

  return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Combined GitHub Stats">
            <rect x="0.5" y="0.5" rx="4.5" height="${height - 1}" width="${
    width - 1
  }" stroke="${borderColor}" fill="${bgColor}" stroke-opacity="1"/>
            <g transform="translate(0, ${topMargin})">
                <text x="${
                  width / 2
                }" y="0" fill="${textColor}" font-size="18" font-weight="bold" text-anchor="middle">
                    Combined GitHub Stats
                </text>
            </g>

            ${createRow(
              "Total Stars",
              totalStars,
              topMargin + titleHeight + lineHeight * 0.5,
              "⭐"
            )}
            ${createRow(
              "Total Commits (Last 365 Days)",
              totalCommits,
              topMargin + titleHeight + lineHeight * 1.5,
              "📊"
            )}
            ${createRow(
              "Total PRs",
              totalPRs,
              topMargin + titleHeight + lineHeight * 2.5,
              "✅"
            )}
            ${createRow(
              "Total Issues",
              totalIssues,
              topMargin + titleHeight + lineHeight * 3.5,
              "❗"
            )}
            ${createRow(
              "Contributed to",
              totalContributedTo,
              topMargin + titleHeight + lineHeight * 4.5,
              "🤝"
            )}
        </svg>
    `;
}

// Vercel serverless function handler
module.exports = async (req, res) => {
  // Add a test endpoint for debugging
  if (req.query.test === "true") {
    res.setHeader("Content-Type", "application/json");
    res.json({
      message: "Test endpoint working",
      timestamp: new Date().toISOString(),
      githubToken: GITHUB_TOKEN ? "Set" : "Not set",
      query: req.query,
    });
    return;
  }

  const personalUsername = req.query.user || "aligheshlaghi97";
  const organizationName = req.query.org || "Finance-Insight-Lab";

  console.log(
    `Fetching data for user: ${personalUsername}, org: ${organizationName}`
  );

  // Fetch data concurrently
  const [personalStars, orgStars, personalContributions] = await Promise.all([
    fetchBestStars(personalUsername),
    fetchBestStars(organizationName),
    fetchPersonalContributionsFromGitHub(personalUsername), // Only fetch personal for GraphQL contribution stats
  ]);

  const cacheKey = `${personalUsername}_${organizationName}`;
  const cachedStars = await getCachedStars(cacheKey);

  // Only a complete read (personal and org) can raise the saved total.
  // A missing side used to be added as zero and then saved for the next visits.
  let totalStars = cachedStars;
  if (personalStars !== null && orgStars !== null) {
    const fetchedStars = personalStars + orgStars;
    if (fetchedStars > cachedStars) {
      await setCachedStars(cacheKey, fetchedStars);
      totalStars = fetchedStars;
      console.log(`✅ Raised cached stars for ${cacheKey}: ${fetchedStars}`);
    } else {
      console.log(
        `Using cached stars for ${cacheKey}: ${cachedStars} (fetched ${fetchedStars})`
      );
    }
  } else {
    console.log(
      `Incomplete star read for ${cacheKey}. Using cached total: ${cachedStars}`
    );
  }

  const combinedData = {
    totalStars: totalStars,
    totalCommits: personalContributions.totalCommits,
    totalPRs: personalContributions.totalPRs,
    totalIssues: personalContributions.totalIssues,
    totalContributedTo: personalContributions.contributedTo,
  };

  console.log("Final combined data:", combinedData);

  const svg = generateSVG(combinedData);

  res.setHeader("Content-Type", "image/svg+xml");
  
  // Prevent caching zero responses - they're likely errors
  // Only cache if we have valid data (totalStars > 0)
  if (totalStars === 0) {
    // Don't cache zero or invalid responses
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    console.log("⚠️ Response contains zero/invalid stars - NOT caching response");
  } else {
    // Cache valid responses for 1 hour
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate");
    console.log("✅ Valid response - caching for 1 hour");
  }
  
  res.send(svg);
};
