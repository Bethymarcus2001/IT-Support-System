# IT Support System

A simple ticketing web app with login, ticket submission, admin analytics, and ticket management.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:5000.

Before deploying, copy `.env.example` to `.env`, then set a unique `JWT_SECRET`, administrator email and strong administrator password. Do not commit `.env` or the `data/` folder.

## Deploying to public hosting

This app is ready to be deployed to services like Render or Railway.

### Render
1. Create a new Web Service.
2. Connect this repository.
3. Set the build command to `npm install`.
4. Set the start command to `npm start`.
5. Add an environment variable:
   - `JWT_SECRET=your-long-random-secret`
   - `ADMIN_EMAIL=admin@yourcompany.com`
   - `ADMIN_PASSWORD=a-strong-password`

The app will serve the frontend and API from the same host.
