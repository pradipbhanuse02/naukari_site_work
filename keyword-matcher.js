globalThis.NaukriKeywordMatcher = (() => {
  function parse(value) {
    return [...new Set(String(value ?? "")
      .split(/[,;\n]/)
      .map((keyword) => keyword.trim().toLocaleLowerCase())
      .filter(Boolean))];
  }

  function count(job, keywords) {
    const searchableText = String(job.skills ?? "").toLocaleLowerCase();

    return keywords.filter((keyword) => searchableText.includes(keyword)).length;
  }

  function score(job, keywords) {
    const matchedSkills = count(job, keywords);
    const percentage = keywords.length === 0
      ? 0
      : Math.round((matchedSkills / keywords.length) * 100);
    return { matchedSkills, totalSkills: keywords.length, percentage };
  }

  function rankAndSelect(jobs, keywords) {
    const scoredJobs = jobs
      .map((job) => ({ ...job, ...score(job, keywords) }))
      .sort((left, right) =>
        right.matchedSkills - left.matchedSkills
        || String(left.title ?? "").localeCompare(String(right.title ?? ""))
      );
    const highestMatch = scoredJobs[0]?.matchedSkills ?? 0;

    return scoredJobs.map((job, index) => {
      const reasons = [];
      if (highestMatch > 0 && job.matchedSkills === highestMatch) {
        reasons.push("Highest skill match");
      }
      if (job.matchedSkills >= 3) {
        reasons.push("3+ matched skills");
      }
      return {
        ...job,
        matchRank: index + 1,
        qualifies: reasons.length > 0,
        qualificationReason: reasons.join("; ")
      };
    });
  }

  return { parse, score, rankAndSelect };
})();
