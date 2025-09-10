# 📊 My Combined GitHub Stats

This Vercel-deployed serverless function generates a dynamic SVG card for your GitHub README, combining total stars from your personal and a specified organization's repositories (sourced from `github-star-counter.workers.dev`) with your personal contribution statistics (commits, PRs, issues, contributed to for the current year, fetched via your GitHub Personal Access Token). To use, deploy this project to Vercel, set your `GITHUB_TOKEN` as an environment variable in Vercel settings, and embed the generated URL (e.g., `https://YOUR_VERCEL_APP_URL/api?user=YOUR_USERNAME&org=YOUR_ORG_NAME`) in an `<img>` tag in your Markdown.

<div align="center">
  <img width="451" height="218" alt="Screenshot from 2025-07-26 22-34-55" src="https://github.com/user-attachments/assets/27575295-66e7-44aa-9603-b42e4f52e70c" />
</div>
