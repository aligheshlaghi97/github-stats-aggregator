const axios = require('axios');

// IMPORTANT: This GITHUB_TOKEN will be provided by Vercel's environment variables.
// It will NOT be committed to your Git repository.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

// Function to fetch stars from github-star-counter.workers.dev (unauthenticated from your side)
async function fetchStarsFromExternalAPI(username) {
    try {
        const response = await axios.get(`https://api.github-star-counter.workers.dev/user/${username}`);
        if (response.data && typeof response.data.stars === 'number') {
            return response.data.stars;
        }
        console.warn(`Could not get stars for ${username} from external API:`, response.data);
        return 0;
    } catch (error) {
        console.error(`Error fetching stars for ${username} from external API:`, error.message);
        return 0;
    }
}

// Function to fetch personal contributions from GitHub GraphQL API (authenticated)
async function fetchPersonalContributionsFromGitHub(username) {
    if (!GITHUB_TOKEN) {
        console.error("GITHUB_TOKEN is not set. Cannot fetch personal contributions from GitHub.");
        return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
    }

    const headers = {
        'Authorization': `bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'github-stats-aggregator-v1'
    };

    const currentYear = new Date().getFullYear();
    const startOfYear = `${currentYear}-01-01T00:00:00Z`;
    const endOfYear = `${currentYear}-12-31T23:59:59Z`;

    const query = `
        query ($login: String!, $startOfYear: DateTime!, $endOfYear: DateTime!) {
            user(login: $login) {
                contributionsCollection(from: $startOfYear, to: $endOfYear) {
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
    const variables = { login: username, startOfYear, endOfYear };

    try {
        const response = await axios.post(GITHUB_GRAPHQL_ENDPOINT, { query, variables }, { headers });

        if (response.data.errors) {
            console.error("GraphQL errors for personal contributions:", response.data.errors);
            // Log specific errors
            response.data.errors.forEach(err => console.error(err.message));
            return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
        }

        const userData = response.data.data.user;
        if (!userData || !userData.contributionsCollection) {
            console.warn(`No contribution data found for user ${username}.`);
            return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
        }

        const contributions = userData.contributionsCollection;

        return {
            totalCommits: contributions.totalCommitContributions,
            totalPRs: contributions.totalPullRequestContributions,
            totalIssues: contributions.totalIssueContributions,
            contributedTo: contributions.totalRepositoriesWithContributedCommits
        };

    } catch (error) {
        console.error(`Error fetching personal contributions for ${username}:`, error.response ? error.response.data : error.message);
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.error("Authentication failed or Rate Limit Exceeded for GraphQL. Check GITHUB_TOKEN and its permissions.");
        }
        return { totalCommits: 0, totalPRs: 0, totalIssues: 0, contributedTo: 0 };
    }
}


// Function to generate the SVG image
function generateSVG(data) {
    const { totalStars, totalCommits, totalPRs, totalIssues, totalContributedTo } = data;

    const textColor = '#c9d1d9';
    const iconColor = '#58a6ff';
    const bgColor = '#0d1117';
    const borderColor = '#30363d';

    const width = 450;
    const height = 220; // Increased height to accommodate all lines
    const padding = 20;
    const lineHeight = 20;

    const createRow = (label, value, y, icon) => `
        <g transform="translate(${padding}, ${y})">
            <text x="0" y="0" fill="${iconColor}" font-size="14">${icon}</text>
            <text x="25" y="0" fill="${textColor}" font-size="14" font-weight="bold">${label}:</text>
            <text x="${width - padding - 50}" y="0" fill="${textColor}" font-size="14" text-anchor="end">${value}</text>
        </g>
    `;

    return `
        <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Combined GitHub Stats">
            <rect x="0.5" y="0.5" rx="4.5" height="${height - 1}" width="${width - 1}" stroke="${borderColor}" fill="${bgColor}" stroke-opacity="1"/>
            <g transform="translate(0, 20)">
                <text x="${width / 2}" y="0" fill="${textColor}" font-size="18" font-weight="bold" text-anchor="middle">
                    Combined GitHub Stats
                </text>
            </g>

            ${createRow('Total Stars', totalStars, padding + lineHeight * 2, '⭐')}
            ${createRow('Total Commits (' + new Date().getFullYear() + ')', totalCommits, padding + lineHeight * 3.5, '📊')}
            ${createRow('Total PRs', totalPRs, padding + lineHeight * 5, '✅')}
            ${createRow('Total Issues', totalIssues, padding + lineHeight * 6.5, '❗')}
            ${createRow('Contributed to', totalContributedTo, padding + lineHeight * 8, '🤝')}
        </svg>
    `;
}

// Vercel serverless function handler
module.exports = async (req, res) => {
    const personalUsername = req.query.user || 'aligheshlaghi97';
    const organizationName = req.query.org || 'Finance-Insight-Lab';

    // Fetch data concurrently
    const [personalStars, orgStars, personalContributions] = await Promise.all([
        fetchStarsFromExternalAPI(personalUsername),
        fetchStarsFromExternalAPI(organizationName),
        fetchPersonalContributionsFromGitHub(personalUsername) // Only fetch personal for GraphQL contribution stats
    ]);

    const totalStars = personalStars + orgStars;

    const combinedData = {
        totalStars: totalStars,
        totalCommits: personalContributions.totalCommits,
        totalPRs: personalContributions.totalPRs,
        totalIssues: personalContributions.totalIssues,
        totalContributedTo: personalContributions.contributedTo
    };

    const svg = generateSVG(combinedData);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // Cache for 1 hour
    res.send(svg);
};
