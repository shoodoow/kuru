import { describe, expect, it } from "vitest";
import { answerWorkerQuestion, askAgent, forgetWorkerQuestions, MAX_QUESTIONS_PER_JOB } from "./worker-questions.js";

describe("a worker's questions to its agent", () => {
  it("waits for the agent's answer and hands it to the worker", async () => {
    const seen: string[] = [];
    const asking = askAgent("job-1", { question: "Vertical or horizontal video?", options: ["vertical", "horizontal"], pick: "vertical" }, (cue) => {
      seen.push(cue.question);
    });
    expect(answerWorkerQuestion("job-1", "Vertical, it is for Instagram.")).toBe(true);
    expect(await asking).toBe("The agent you work for answers: Vertical, it is for Instagram.");
    expect(seen).toEqual(["Vertical or horizontal video?"]);
    // Nothing is waiting any more, so a later note is an ordinary note.
    expect(answerWorkerQuestion("job-1", "late")).toBe(false);
    forgetWorkerQuestions("job-1");
  });

  it("carries on with the worker's own pick when no answer comes", async () => {
    const answer = await askAgent("job-2", { question: "Which logo file should go on the last frame?", pick: "logo-dark.png" }, () => undefined, 20);
    expect(answer).toContain("No answer came in time");
    expect(answer).toContain("logo-dark.png");
    forgetWorkerQuestions("job-2");
  });

  it("refuses a question that is the worker's own job, without waking the agent", async () => {
    let woken = 0;
    const answer = await askAgent("job-3", { question: "How do I install ffmpeg on this computer?" }, () => {
      woken += 1;
    });
    expect(answer).toContain("yours to work out");
    expect(woken).toBe(0);
  });

  it("allows only a few questions per job", async () => {
    for (let round = 0; round < MAX_QUESTIONS_PER_JOB; round += 1) {
      const asking = askAgent("job-4", { question: `Which colour for part ${round}?` }, () => undefined);
      answerWorkerQuestion("job-4", "Blue.");
      expect(await asking).toContain("Blue.");
    }
    let woken = 0;
    const refused = await askAgent("job-4", { question: "And which font should it use?", pick: "Inter" }, () => {
      woken += 1;
    });
    expect(refused).toContain("which is the limit");
    expect(refused).toContain("Inter");
    expect(woken).toBe(0);
    forgetWorkerQuestions("job-4");
  });
});
