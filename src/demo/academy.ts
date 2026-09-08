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
  counsellor: {
    name: "Sarah Mitchell",
    initials: "SM",
    title: "Learner success counsellor",
    checkin: "Thu, 10 Sep · 16:30",
    hours: 6,
    goal: "Build a consistent evening study routine and prepare confidently for an external examination.",
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
      meta: "Counsellor check-in · 10 min",
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
      title: "Prepare for your counsellor check-in",
      body: "Take a moment to reflect on what is working well and where you would welcome support.",
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
