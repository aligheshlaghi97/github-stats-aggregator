const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Import the Vercel function
const vercelFunction = require('./api/index.js');

// Middleware to parse query parameters
app.use(express.urlencoded({ extended: true }));

// Route to handle the API
app.get('/api', async (req, res) => {
    try {
        await vercelFunction(req, res);
    } catch (error) {
        console.error('Error in API handler:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Root route with instructions
app.get('/', (req, res) => {
    res.send(`
        <h1>GitHub Stats Aggregator - Local Testing</h1>
        <h2>Available Endpoints:</h2>
        <ul>
            <li><a href="/api?test=true">Test endpoint</a> - Check if server is working</li>
            <li><a href="/api">Default stats</a> - Your default stats</li>
            <li><a href="/api?user=YOUR_USERNAME">Custom user</a> - Replace YOUR_USERNAME with your GitHub username</li>
            <li><a href="/api?user=YOUR_USERNAME&org=YOUR_ORG">Custom user + org</a> - Add organization</li>
        </ul>
        
        <h2>Environment Variables:</h2>
        <p>GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? '✅ Set' : '❌ Not set'}</p>
        
        <h2>Instructions:</h2>
        <ol>
            <li>Make sure you have a .env file with GITHUB_TOKEN=your_token_here</li>
            <li>Check the console logs for debugging information</li>
            <li>Test different endpoints to see the data</li>
        </ol>
    `);
});

app.listen(PORT, () => {
    console.log(`🚀 Local server running on http://localhost:${PORT}`);
    console.log(`📊 Test your API at: http://localhost:${PORT}/api`);
    console.log(`🔧 Test endpoint: http://localhost:${PORT}/api?test=true`);
    console.log(`🔑 GitHub Token: ${process.env.GITHUB_TOKEN ? 'Set' : 'Not set'}`);
});
