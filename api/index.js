const axios = require('axios');
// const path = require('path'); // Not needed if dotenv isn't used for local dev in Vercel context
// require('dotenv').config({ path: path.resolve(__dirname, '../.env') }); // No dotenv for Vercel

const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Vercel injects this securely
const GITHUB_GRAPHQL_ENDPOINT = 'https://api.github.com/graphql';

async function fetchGitHubData(username, isOrganization = false) {
    if (!GITHUB_TOKEN) {
        console.error("GITHUB_TOKEN is not set. Cannot make authenticated API calls.");
        return null; // Or throw an error
    }

    const headers = {
        'Authorization': `bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'github-stats-aggregator-v1' // Good practice
    };

    let query;
    let variables;
    let aggregatedStars = 0; // For organizations

    try {
        if (isOrganization) {
            // GraphQL query to get an organization's repositories and their star counts
            query = `
                query ($login: String!, $cursor: String) {
                    organization(login: $login) {
                        repositories(first: 100, after: $cursor, privacy: ALL) {
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                            nodes {
                                stargazerCount
                                isFork
                            }
                        }
                    }
                    rateLimit {
                        remaining
                        resetAt
                    }
                }
            `;
            let hasNextPage = true;
            let cursor = null;

            while (hasNextPage) {
                variables = { login: username, cursor };
                const response = await axios.post(GITHUB_GRAPHQL_ENDPOINT, { query, variables }, { headers });

                if (response.data.errors) {
                    console.error("GraphQL errors for organization:", response.data.errors);
                    throw new Error("GraphQL error for organization.");
                }

                const orgData = response.data.data.organization;
                if (!orgData || !orgData.repositories) break;

                orgData.repositories.nodes.forEach(repo => {
                    // Only count stars from non-forked repositories
                    if (!repo.isFork) {
                        aggregatedStars += repo.stargazerCount;
                    }
                });

                hasNextPage = orgData.repositories.pageInfo.hasNextPage;
                cursor = orgData.repositories.pageInfo.endCursor;
                // Optional: add a small delay if you anticipate hitting secondary rate limits
                // await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { stars: aggregatedStars };
        } else {
            // GraphQL query for user contributions and owned/starred repos
            const currentYear = new Date().getFullYear();
            const startOfYear = `${currentYear}-01-01T00:00:00Z`;
            const endOfYear = `${currentYear}-12-31T23:59:59Z`;

            query = `
                query ($login: String!, $startOfYear: DateTime!, $endOfYear: DateTime!) {
                    user(login: $login) {
                        contributionsCollection(from: $startOfYear, to: $endOfYear) {
                            totalCommitContributions
                            totalPullRequestContributions
                            totalIssueContributions
                            restrictedContributionsCount // Public + private (excluding forks)
                            totalRepositoriesWithContributedCommits
                        }
                        # Stars on repositories *owned* by the user
                        repositories(first: 100, privacy: ALL, ownerAffiliations: [OWNER]) {
                            nodes {
                                stargazerCount
                                isFork
                            }
                            pageInfo {
                                hasNextPage
                                endCursor
                            }
                        }
                         # Stars on repositories the user has *starred* themselves (this is what my prev unauth code got)
                        starredRepositories {
                            totalCount
                        }
                    }
                    rateLimit {
                        remaining
                        resetAt
                    }
                }
            `;
            variables = { login: username, startOfYear, endOfYear };
            const response = await axios.post(GITHUB_GRAPHQL_ENDPOINT, { query, variables }, { headers });

            if (response.data.errors) {
                console.error("GraphQL errors for user:", response.data.errors);
                throw new Error("GraphQL error for user.");
            }

            const userData = response.data.data.user;
            if (!userData) return null;

            const contributions = userData.contributionsCollection;
            let userOwnedRepoStars = 0;
            let userStarredTotal = userData.starredRepositories.totalCount || 0; // Total repos user starred

            // Sum stars from repositories *owned* by the user (or where they are primary owner)
            // This correctly gets the 27 for aligheshlaghi97 from your worker.dev call
            if (userData.repositories && userData.repositories.nodes) {
                userData.repositories.nodes.forEach(repo => {
                    if (!repo.isFork) {
                        userOwnedRepoStars += repo.stargazerCount;
                    }
                });
                // Note: If user has >100 owned repos, this needs pagination too.
                // For most personal profiles, 100 is enough.
                if (userData.repositories.pageInfo.hasNextPage) {
                    console.warn(`User ${username} has more than 100 owned repositories. Star count might be incomplete without pagination for owned repos.`);
                }
            }

            // Decide which "stars" you want for the personal user:
            // 1. userOwnedRepoStars: Stars on repos you own (e.g., 27 for you)
            // 2. userStarredTotal: Stars on repos you have starred (your previous code got this, likely 64)
            // 3. (Less common) Combine both: userOwnedRepoStars + userStarredTotal
            // Given your initial requirement of 27 from your own, we'll use userOwnedRepoStars
            const personalUserStars = userOwnedRepoStars;


            return {
                stars: personalUserStars,
                totalCommits: contributions.totalCommitContributions,
                totalPRs: contributions.totalPullRequestContributions,
                totalIssues: contributions.totalIssueContributions,
                contributedTo: contributions.totalRepositoriesWithContributedCommits
            };
        }
    } catch (error) {
        console.error(`Error fetching GitHub data for ${username}:`, error.response ? error.response.data : error.message);
        if (error.response && (error.response.status === 401 || error.response.status === 403)) {
            console.error("Authentication failed or Rate Limit Exceeded. Check GITHUB_TOKEN and its permissions.");
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
    // You can retrieve username and organization from query parameters,
    // or hardcode them if they'll always be the same.
    const personalUsername = req.query.user || 'aligheshlaghi97';
    const organizationName = req.query.org || 'Finance-Insight-Lab'; // Default or allow custom org

    // Fetch data concurrently
    const [personalStats, orgStats] = await Promise.all([
        fetchGitHubData(personalUsername, false), // isOrganization = false
        fetchGitHubData(organizationName, true)   // isOrganization = true
    ]);

    let totalStars = 0;
    let totalCommits = 0;
    let totalPRs = 0;
    let totalIssues = 0;
    let totalContributedTo = 0;

    // Aggregate personal stats
    if (personalStats) {
        totalStars += personalStats.stars;
        totalCommits += personalStats.totalCommits;
        totalPRs += personalStats.totalPRs;
        totalIssues += personalStats.totalIssues;
        totalContributedTo += personalStats.contributedTo;
    }

    // Aggregate organization stars (only stars for organizations from the custom API)
    if (orgStats) {
        totalStars += orgStats.stars;
        // The user's contributionsCollection from GraphQL *should* already include contributions to organization repos.
        // So, we don't need to add commits/PRs/issues from orgStats unless you want to count
        // ALL activity *within the organization*, not just *your* activity there.
        // Given your initial input, we're focusing on *your* total impact.
    }

    const combinedData = {
        totalStars,
        totalCommits,
        totalPRs,
        totalIssues,
        totalContributedTo
    };

    const svg = generateSVG(combinedData);

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate'); // Cache for 1 hour
    res.send(svg);
};
