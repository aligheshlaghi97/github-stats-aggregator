const axios = require('axios');
// No dotenv needed if no GITHUB_TOKEN

// GitHub REST API Base URL
const GITHUB_REST_API_BASE = 'https://api.github.com';

// Function to fetch GitHub data for a single user/organization using REST API
async function fetchGitHubData(username, isOrganization = false) {
    // Headers are still good practice, even without auth
    const headers = {
        'User-Agent': 'github-stats-aggregator-v1', // Required by GitHub API
        'Accept': 'application/vnd.github.v3+json', // Recommended for V3 REST API
    };

    try {
        if (isOrganization) {
            // *** IMPORTANT: Fetching organization stats like "total commits"
            // *** for an unauthenticated user is EXTREMELY DIFFICULT/IMPOSSIBLE
            // *** via REST API without iterating all its repos and contributions,
            // *** which will instantly hit rate limits.
            // *** For organizations, we'll try to get overall repo stars.

            let totalOrgStars = 0;
            let hasNextPage = true;
            let page = 1;

            while(hasNextPage && page <= 5) { // Limit pages to avoid hitting rate limits too quickly
                const response = await axios.get(
                    `${GITHUB_REST_API_BASE}/orgs/${username}/repos?per_page=100&page=${page}&type=public`,
                    { headers }
                );
                const repos = response.data;

                if (repos.length === 0) {
                    hasNextPage = false;
                    break;
                }

                repos.forEach(repo => {
                    if (!repo.fork) { // Only count stars from non-forked repos
                        totalOrgStars += repo.stargazers_count;
                    }
                });

                // Check for next page link in headers (unreliable for simple pagination sometimes)
                const linkHeader = response.headers.link;
                hasNextPage = linkHeader && linkHeader.includes('rel="next"');
                page++;

                // Add a small delay between requests to be gentle on rate limits
                await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 sec delay
            }

            return { stars: totalOrgStars }; // Only stars are semi-feasible for orgs unauthenticated
        } else {
            // Fetch user profile for public stats
            const userResponse = await axios.get(`${GITHUB_REST_API_BASE}/users/${username}`, { headers });
            const userData = userResponse.data;

            // Getting total commits, PRs, issues without GraphQL's contributionsCollection
            // and without authentication is *very hard and rate-limit-intensive*.
            // The public user endpoint only gives you public_repos, public_gists, followers, following.
            // It does NOT give you total stars *given* or total contributions easily.
            // For stars, `starred_url` would need another paginated request.

            let totalUserStars = 0;
            let userStarsPage = 1;
            let hasNextUserStarsPage = true;

            while (hasNextUserStarsPage && userStarsPage <= 5) { // Limit pages
                const starredResponse = await axios.get(
                    `${GITHUB_REST_API_BASE}/users/${username}/starred?per_page=100&page=${userStarsPage}`,
                    { headers }
                );
                totalUserStars += starredResponse.data.length; // Count starred repos

                const linkHeader = starredResponse.headers.link;
                hasNextUserStarsPage = linkHeader && linkHeader.includes('rel="next"');
                userStarsPage++;
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // *** IMPORTANT: These will be placeholders or very inaccurate for unauthenticated.
            // *** GitHub REST API does not easily provide these aggregated numbers for unauthenticated users.
            // *** You would typically need to hit multiple event/activity endpoints, which would destroy your rate limit.
            // *** This is why a token or dedicated service (like github-readme-stats or your worker.dev) is used.
            const totalCommits = 0; // Cannot easily get without specific repo queries / events
            const totalPRs = 0;     // Cannot easily get
            const totalIssues = 0;  // Cannot easily get
            const contributedTo = 0; // Cannot easily get


            return {
                stars: totalUserStars,
                totalCommits: totalCommits,
                totalPRs: totalPRs,
                totalIssues: totalIssues,
                contributedTo: contributedTo
            };
        }
    } catch (error) {
        console.error(`Error fetching GitHub data for ${username}:`, error.response ? error.response.data : error.message);
        // Check for rate limit exceeded
        if (error.response && error.response.status === 403 && error.response.headers['x-ratelimit-remaining'] === '0') {
            console.error("GitHub API Rate Limit Exceeded for unauthenticated requests!");
        }
        return null;
    }
}


// Function to generate the SVG image (same as before)
function generateSVG(data) {
    const { totalStars, totalCommits, totalPRs, totalIssues, totalContributedTo } = data;

    const textColor = '#c9d1d9';
    const iconColor = '#58a6ff';
    const bgColor = '#0d1117';
    const borderColor = '#30363d';

    const width = 450;
    const height = 180;
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

    const [personalStats, orgStats] = await Promise.all([
        fetchGitHubData(personalUsername, false),
        fetchGitHubData(organizationName, true)
    ]);

    let totalStars = 0;
    let totalCommits = 0;
    let totalPRs = 0;
    let totalIssues = 0;
    let totalContributedTo = 0;

    // Aggregate personal stars (only what can be obtained unauthenticated)
    if (personalStats) {
        totalStars += personalStats.stars;
        // Commits, PRs, Issues, ContributedTo will likely be 0 or highly inaccurate
        // as unauthenticated REST API doesn't easily provide them aggregated.
    }

    // Aggregate organization stars
    if (orgStats) {
        totalStars += orgStats.stars;
    }

    const combinedData = {
        totalStars,
        totalCommits, // Will be 0
        totalPRs,     // Will be 0
        totalIssues,  // Will be 0
        totalContributedTo // Will be 0
    };

    const svg = generateSVG(combinedData);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate'); // Very short cache for unauthenticated
    res.send(svg);
};
