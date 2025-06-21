# Disaster Response Platform Backend

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create a `.env` file** in the project root with the following variables:
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_ANON_KEY=your_supabase_anon_key
   GOOGLE_GEMINI_API_KEY=your_gemini_api_key
   GOOGLE_MAPS_API_KEY=your_google_maps_api_key
   PORT=4000
   ```

3. **Run the server:**
   ```bash
   node index.js
   ```

The server will start on `http://localhost:4000` by default.

## Features
- Express.js REST API
- Supabase integration
- Socket.IO for real-time updates
- External API integrations (Google Gemini, Google Maps, etc.)

## Supabase Postgres Function: nearby_resources

To enable geospatial resource lookup, create this function in your Supabase SQL editor:

```sql
create or replace function nearby_resources(
  disaster_id_param uuid,
  lat_param double precision,
  lon_param double precision,
  radius_param integer
)
returns setof resources as $$
begin
  return query
    select * from resources
    where disaster_id = disaster_id_param
      and ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint(lon_param, lat_param), 4326),
        radius_param
      );
end;
$$ language plpgsql;
```

This function returns all resources for a given disaster within a specified radius (in meters) of the provided lat/lon.

---

*This backend was rapidly scaffolded using Cursor AI tooling.* 