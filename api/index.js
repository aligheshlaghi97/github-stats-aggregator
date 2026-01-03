const axios = require("axios");

// IMPORTANT: This GITHUB_TOKEN will be provided by Vercel's environment variables.
// It will NOT be committed to your Git repository.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

// In-memory storage for highest total stars (keyed by username+org combination)
const highestStarsCache = {};

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

// Function to fetch stars from github-star-counter.workers.dev (unauthenticated from your side)
// Added retry logic to handle transient failures
async function fetchStarsFromExternalAPI(username, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(
        `https://api.github-star-counter.workers.dev/user/${username}`,
        { timeout: 10000 } // 10 second timeout
      );
      if (response.data && typeof response.data.stars === "number" && response.data.stars > 0) {
        console.log(`Successfully fetched stars for ${username}: ${response.data.stars} (attempt ${attempt})`);
        return response.data.stars;
      }
      // If we get a response but stars is 0 or invalid, log it but don't retry immediately
      if (response.data && typeof response.data.stars === "number" && response.data.stars === 0) {
        console.warn(
          `API returned zero stars for ${username} (attempt ${attempt}). This might be valid or an error.`
        );
        // Only return 0 if this is the last attempt
        if (attempt === retries) {
          return 0;
        }
        // Wait a bit before retrying
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      console.warn(
        `Invalid response format for ${username} from external API (attempt ${attempt}):`,
        response.data
      );
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      return 0;
    } catch (error) {
      console.error(
        `Error fetching stars for ${username} from external API (attempt ${attempt}/${retries}):`,
        error.message
      );
      if (attempt < retries) {
        // Exponential backoff: wait longer between retries
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        continue;
      }
      return 0;
    }
  }
  return 0;
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
    fetchStarsFromExternalAPI(personalUsername),
    fetchStarsFromExternalAPI(organizationName),
    fetchPersonalContributionsFromGitHub(personalUsername), // Only fetch personal for GraphQL contribution stats
  ]);

  const calculatedTotalStars = personalStars + orgStars;

  // Create a cache key for this user+org combination
  const cacheKey = `${personalUsername}_${organizationName}`;

  // Get the highest stored value (or 0 if not exists)
  const highestStoredStars = highestStarsCache[cacheKey] || 0;

  // Determine which value to use and update cache
  // Always prefer stored value if calculated is zero or lower (API issues)
  let totalStars;
  let shouldCache = false; // Flag to prevent caching zero responses
  
  if (calculatedTotalStars > highestStoredStars) {
    // New highest value found, update cache and use it
    highestStarsCache[cacheKey] = calculatedTotalStars;
    totalStars = calculatedTotalStars;
    shouldCache = true;
    console.log(
      `✅ Updated highest stars cache for ${cacheKey}: ${calculatedTotalStars}`
    );
  } else if (calculatedTotalStars === 0) {
    // API returned zero - this is likely an error
    if (highestStoredStars > 0) {
      // Use stored value and don't cache this zero response
      totalStars = highestStoredStars;
      shouldCache = false; // Don't cache zero responses
      console.log(
        `⚠️ API returned zero stars, using stored highest value: ${highestStoredStars} (NOT caching zero)`
      );
    } else {
      // Both are zero - might be first time or real zero
      totalStars = 0;
      shouldCache = false; // Don't cache zero responses
      console.log(
        `⚠️ No stars found and no cached value. Returning zero but NOT caching.`
      );
    }
  } else if (calculatedTotalStars < highestStoredStars) {
    // Calculated value is lower than stored (possible API issue), use stored value
    totalStars = highestStoredStars;
    shouldCache = false; // Don't cache lower values
    console.log(
      `⚠️ Using stored highest stars (${highestStoredStars}) instead of calculated (${calculatedTotalStars}) - possible API issue`
    );
  } else {
    // Use calculated value (equal to stored)
    totalStars = calculatedTotalStars;
    shouldCache = true;
    if (calculatedTotalStars > 0 && highestStoredStars === 0) {
      // First time seeing a valid value, store it
      highestStarsCache[cacheKey] = calculatedTotalStars;
      console.log(
        `✅ First valid value stored for ${cacheKey}: ${calculatedTotalStars}`
      );
    }
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
  if (totalStars === 0 || !shouldCache) {
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
