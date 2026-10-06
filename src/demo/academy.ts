// Fictional fixtures only. Never imported by authenticated data services.
export const demo = {
  student: {
    name: "Alex Morgan",
    number: "DUC-DEMO-001",
    initials: "AM",
  },
  programme: {
    title: "ISC2 Certified in Cybersecurity (CC)",
    shortTitle: "Certified in Cybersecurity",
    version: "2026 · Demonstration blueprint",
    progress: 36,
    modulesComplete: 2,
    moduleCount: 5,
    body: "ISC2",
    cohort: "September 2026 · Evening cohort",
  },
  lesson: {
    title: "Access Control Fundamentals",
    module: "Security principles",
    date: "Tuesday, 8 September",
    time: "18:00–19:00",
    timezone: "Europe/London",
    progress: 72,
    mastery: 3,
    objectives: [
      "Explain authentication",
      "Explain authorisation",
      "Explain least privilege",
      "Explain role-based access control",
      "Explain multi-factor authentication",
    ],
  },
  // AC-5: Sarah Mitchell is Ducelio's AI learner-success counsellor and
  // learner guide, the same persona the signed-in academy runs. She is AI,
  // not a human member of staff. No AI is connected in this demo.
  counsellor: {
    name: "Sarah Mitchell",
    initials: "SM",
    title: "Ducelio AI learner-success counsellor",
    routineReview: "Thu, 10 Sep",
    hours: 6,
    goal: "Build a consistent evening study routine and prepare confidently for an external examination.",
  },
  // A fictional HUMAN counsellor, shown only in the staff workspace preview.
  // Human counsellors remain distinct from Sarah.
  humanCounsellor: {
    name: "Jamie Carter",
    title: "Learner success counsellor (fictional human staff)",
  },
  tasks: [
    {
      title: "Review your access control notes",
      meta: "Study plan · 20 min",
      due: "Today",
      done: true,
    },
    {
      title: "Prepare for your next class",
      meta: "Security principles · 15 min",
      due: "Today",
      done: false,
    },
    {
      title: "Reflect on this week’s study rhythm",
      meta: "Study-routine review · 10 min",
      due: "Thu, 10 Sep",
      done: false,
    },
  ],
  assignments: [
    {
      title: "Least privilege in everyday systems",
      module: "Security principles",
      due: "Fri, 11 Sep",
      status: "Upcoming",
    },
  ],
  assessments: [
    {
      title: "Security principles · knowledge check",
      detail: "Illustrative assessment · 15 questions",
      due: "Mon, 14 Sep",
    },
  ],
  announcements: [
    {
      title: "Your September academy briefing",
      body: "Make room for a steady study rhythm. Your programme and study plan are ready to explore.",
      date: "8 Sep",
      tag: "Academy",
    },
    {
      title: "Review your study routine",
      body: "Take a moment to reflect on what is working well. Sarah Mitchell, Ducelio’s AI learner-success counsellor, can help you organise your support preferences.",
      date: "7 Sep",
      tag: "Student support",
    },
  ],
  followups: [
    {
      title: "Review your weekly study routine",
      due: "Thu, 10 Sep",
      status: "Open",
    },
  ],
  events: [
    {
      title: "Your first programme milestone",
      detail: "Demo milestone event · ready for a progress discussion",
      status: "Open",
    },
  ],
} as const;
