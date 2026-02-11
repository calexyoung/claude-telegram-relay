/**
 * Weather Integration — OpenWeatherMap
 *
 * Free tier: 60 calls/min, 1M calls/mo.
 * Sign up at openweathermap.org/api
 */

const API_KEY = process.env.OPENWEATHERMAP_API_KEY || "";
const LOCATION = process.env.WEATHER_LOCATION || "";

export interface WeatherData {
  location: string;
  temp: number;
  feelsLike: number;
  conditions: string;
  humidity: number;
  windSpeed: number;
  forecast: string; // brief text summary
}

export function isWeatherAvailable(): boolean {
  return !!API_KEY && !API_KEY.includes("your_") && !!LOCATION;
}

/**
 * Get current weather and today's forecast for the configured location.
 */
export async function getWeather(): Promise<WeatherData | null> {
  if (!isWeatherAvailable()) return null;

  try {
    // Current weather
    const currentUrl = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(LOCATION)}&appid=${API_KEY}&units=metric`;
    const currentRes = await fetch(currentUrl);
    if (!currentRes.ok) return null;

    const current = (await currentRes.json()) as {
      name: string;
      main: { temp: number; feels_like: number; humidity: number };
      weather: Array<{ description: string }>;
      wind: { speed: number };
    };

    // Today's forecast (3-hour intervals)
    const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(LOCATION)}&appid=${API_KEY}&units=metric&cnt=8`;
    const forecastRes = await fetch(forecastUrl);
    let forecastSummary = "";

    if (forecastRes.ok) {
      const forecastData = (await forecastRes.json()) as {
        list: Array<{
          dt_txt: string;
          main: { temp: number };
          weather: Array<{ description: string }>;
        }>;
      };

      // Find high/low and conditions for rest of day
      const temps = forecastData.list.map((f) => f.temp || f.main.temp);
      const high = Math.round(Math.max(...temps));
      const low = Math.round(Math.min(...temps));
      const conditions = [...new Set(forecastData.list.map((f) => f.weather[0]?.description))];
      forecastSummary = `High ${high}°C / Low ${low}°C. ${conditions.join(", ")}`;
    }

    return {
      location: current.name,
      temp: Math.round(current.main.temp),
      feelsLike: Math.round(current.main.feels_like),
      conditions: current.weather[0]?.description || "unknown",
      humidity: current.main.humidity,
      windSpeed: current.wind.speed,
      forecast: forecastSummary,
    };
  } catch {
    return null;
  }
}

/**
 * Format weather data as a human-readable string.
 */
export function formatWeather(data: WeatherData): string {
  const parts = [
    `${data.temp}°C (feels like ${data.feelsLike}°C), ${data.conditions}`,
  ];
  if (data.forecast) parts.push(data.forecast);
  return parts.join("\n");
}
