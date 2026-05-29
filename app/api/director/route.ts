import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 60;

type BeatInput = {
  startTime: number;
  endTime: number;
  searchQuery: string;
  reasoning: string;
  images?: string[];
  selectedImageIdx?: number;
  pos?: { x: number; y: number };
  size?: number;
  customImageUrl?: string;
  customVideoUrl?: string;
};

type ProposedBeat = BeatInput & {
  wantsVideo?: boolean;
  youtubeId?: string;
  youtubeTitle?: string;
  youtubeThumbnail?: string;
  youtubeDurationSecs?: number;
};

async function searchImages(query: string, apiKey: string): Promise<string[]> {
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, num: 10 }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.images || [])
      .map((img: { imageUrl?: string; thumbnailUrl?: string }) => img.imageUrl || img.thumbnailUrl || "")
      .filter((url: string) => url && url.startsWith("http"))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function searchVideo(
  query: string,
  railwayUrl: string,
  password: string
): Promise<{ id: string; title: string; thumbnail: string; duration_seconds: number } | null> {
  try {
    const res = await fetch(`${railwayUrl}/video-search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-neuralboard-password": password,
      },
      body: JSON.stringify({ query, limit: 3 }),
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results) || results.length === 0) return null;
    return results[0];
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { notes, beats } = await req.json();
    if (!notes || !Array.isArray(beats)) {
      return NextResponse.json({ error: "Missing notes or beats" }, { status: 400 });
    }

    const openaiKey = process.env.OPENAI_API_KEY;
    const serperKey = process.env.SERPER_API_KEY;
    const railwayUrl = process.env.NEXT_PUBLIC_RAILWAY_URL || "";
    const password = process.env.NEURALBOARD_PASSWORD || "";

    if (!openaiKey) {
      return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    }

    const inputBeats = beats as BeatInput[];
    const totalDuration =
      inputBeats.length > 0 ? inputBeats[inputBeats.length - 1].endTime : 0;

    const systemPrompt = `You are a video director AI. Given a current beats array and director notes from the user, propose a revised beats array that implements their instructions.

RULES:
- Total video duration is ${totalDuration.toFixed(1)}s. First beat MUST start at 0, last beat MUST end at ${totalDuration.toFixed(1)}.
- Beats are sequential and non-overlapping: beat[i].endTime must equal beat[i+1].startTime.
- Each beat needs: startTime (number), endTime (number), searchQuery (3-6 specific words), reasoning (string).
- If the user wants a specific beat to use video footage, set wantsVideo: true and make searchQuery YouTube-optimized.
- For image beats (wantsVideo omitted or false), searchQuery should be Google Images-friendly.
- GOOD searchQuery: "UFO sighting footage night sky", "SpaceX Falcon 9 launch", "Tokyo neon street rain"
- BAD searchQuery: "video", "beat 2 content", "cool footage"

Return ONLY valid JSON: {"beats": [{"startTime": number, "endTime": number, "searchQuery": string, "reasoning": string, "wantsVideo": boolean}]}`;

    const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Current beats:\n${JSON.stringify(
              inputBeats.map((b) => ({
                startTime: b.startTime,
                endTime: b.endTime,
                searchQuery: b.searchQuery,
                reasoning: b.reasoning,
              })),
              null,
              2
            )}\n\nDirector notes: "${notes}"`,
          },
        ],
      }),
    });

    if (!gptRes.ok) {
      const err = await gptRes.json().catch(() => ({}));
      return NextResponse.json(
        {
          error:
            (err as { error?: { message?: string } })?.error?.message ||
            `AI error ${gptRes.status}`,
        },
        { status: 500 }
      );
    }

    const gptData = await gptRes.json();
    const gptText = gptData.choices?.[0]?.message?.content || "{}";

    let rawBeats: Array<{
      startTime: number;
      endTime: number;
      searchQuery: string;
      reasoning: string;
      wantsVideo?: boolean;
    }> = [];

    try {
      const parsed = JSON.parse(gptText);
      rawBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
    } catch {
      return NextResponse.json({ error: "AI returned invalid JSON" }, { status: 500 });
    }

    // Normalize and clamp
    rawBeats = rawBeats
      .map((b, i) => ({
        startTime: Number(b.startTime) || i * (totalDuration / Math.max(1, rawBeats.length)),
        endTime: Number(b.endTime) || (i + 1) * (totalDuration / Math.max(1, rawBeats.length)),
        searchQuery: String(b.searchQuery || "").trim() || "generic image",
        reasoning: String(b.reasoning || ""),
        wantsVideo: !!b.wantsVideo,
      }))
      .sort((a, b) => a.startTime - b.startTime);

    if (rawBeats.length > 0) {
      rawBeats[0].startTime = 0;
      rawBeats[rawBeats.length - 1].endTime = totalDuration;
      for (let i = 1; i < rawBeats.length; i++) {
        rawBeats[i].startTime = Math.max(rawBeats[i - 1].endTime, rawBeats[i].startTime);
        rawBeats[i].endTime = Math.max(rawBeats[i].startTime + 0.5, rawBeats[i].endTime);
      }
    }

    // Fetch media in parallel for all beats
    const proposedBeats: ProposedBeat[] = await Promise.all(
      rawBeats.map(async (b, i): Promise<ProposedBeat> => {
        const base: ProposedBeat = {
          ...b,
          pos: inputBeats[i]?.pos,
          size: inputBeats[i]?.size,
          selectedImageIdx: 0,
        };

        if (b.wantsVideo && railwayUrl && password) {
          const video = await searchVideo(b.searchQuery, railwayUrl, password);
          if (video) {
            return {
              ...base,
              youtubeId: video.id,
              youtubeTitle: video.title,
              youtubeThumbnail: video.thumbnail,
              youtubeDurationSecs: video.duration_seconds,
            };
          }
          // Video search failed — fall through to image
        }

        if (serperKey) {
          const images = await searchImages(b.searchQuery, serperKey);
          return { ...base, images };
        }

        return base;
      })
    );

    return NextResponse.json({ ok: true, beats: proposedBeats });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
