const axios = require('axios');

// Function to fetch stars from github-star-counter.workers.dev
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

// Function to generate the SVG image (same as before)
function generateSVG(data) {
    const { totalStars, totalCommits, totalPRs, totalIssues, totalContributedTo } = data;

    const textColor = '#c9d1d9';
    const iconColor = '#58a6ff';
    const bgColor = '#0d1117';
    const borderColor = '#30363d';

    const width = 450;
    const height = 220;
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

    // Fetch stars from the external service
    const [personalStars, orgStars] = await Promise.all([
        fetchStarsFromExternalAPI(personalUsername),
        fetchStarsFromExternalAPI(organizationName)
    ]);

    const totalStars = personalStars + orgStars;

    // All other metrics will be 0 as there's no unauthenticated API for them
    const combinedData = {
        totalStars: totalStars,
        totalCommits: 0, // Cannot get without GitHub Token / dedicated API
        totalPRs: 0,     // Cannot get without GitHub Token / dedicated API
        totalIssues: 0,  // Cannot get without GitHub Token / dedicated API
        totalContributedTo: 0 // Cannot get without GitHub Token / dedicated API
    };

    const svg = generateSVG(combinedData);

    res.setHeader('Content-Type', 'image/svg+xml');
    // Cache for 1 hour for stars, but consider that other values are static 0
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');
    res.send(svg);
};
