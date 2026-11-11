// Player level guide — "player-levels-v1" (Paul's guide, 11 Nov 2026; squash added by Claude in the same style).
// Groups are derived from the number here and in SQL (level_group): Beginner 1–3 · Intermediate 4–6 · Advanced 7–10.

export const GUIDE_VERSION = "player-levels-v1";
export type Group = "beginner" | "intermediate" | "advanced";
export function levelGroup(level: number | null | undefined): Group | null {
  if (level == null) return null;
  return level <= 3 ? "beginner" : level <= 6 ? "intermediate" : "advanced";
}
export const GROUP_LABEL: Record<Group, string> = { beginner: "Beginner", intermediate: "Intermediate", advanced: "Advanced" };
export const GROUP_RANGE: Record<Group, [number, number]> = { beginner: [1, 3], intermediate: [4, 6], advanced: [7, 10] };
export function levelLabel(level: number | null | undefined): string { const g = levelGroup(level); return level == null || !g ? "Level not set" : `Level ${level} · ${GROUP_LABEL[g]}`; }
export function rangeLabel(min: number | null, max: number | null, legacy = false): string {
  if (min == null || max == null) return "All levels welcome";
  return `Levels ${min}–${max}${legacy ? " (approx.)" : ""}`;
}
export function fitLabel(my: number | null | undefined, min: number | null, max: number | null): { text: string; tone: "ok" | "warn" | "muted" } {
  if (min == null || max == null) return { text: "All levels welcome", tone: "ok" };
  if (my == null) return { text: "Set your level to see fit", tone: "muted" };
  if (my < min) return { text: `You're Level ${my} · below range`, tone: "warn" };
  if (my > max) return { text: `You're Level ${my} · above range`, tone: "warn" };
  return { text: `You're Level ${my} · fits`, tone: "ok" };
}

export const HOW_TO_CHOOSE = [
  "Pick your sport and read the descriptions.",
  "Choose the level that best matches your usual game over your recent sessions.",
  "If you are between two levels, start with the lower one and see how your games feel.",
  "Update your level when your usual performance changes.",
];
export const INTRO = "Games are more enjoyable when everyone can keep up and contribute. Choose a level for each sport to help other players find a suitable game with you. Think about how you usually play: your control, your decisions and how well you manage when opponents give you less time. Pick the description that fits most often. You can choose a different level for every sport.";

export const GUIDE: Record<string, { intro: string; levels: { level: number; text: string }[] }> = {
  padel: {
    intro: "In this guide, a lob is a high shot over the opponents. A volley is a shot played before the bounce. Playing off the glass means returning the ball after it bounces on your side and rebounds from the glass.",
    levels: [
      { level: 1, text: "You are trying padel for the first time. You need help with where to stand, serving and scoring." },
      { level: 2, text: "You can start some points with a legal serve and return easy balls. Exchanges often end before you can get into position." },
      { level: 3, text: "You can exchange several controlled shots and follow the score yourself. You are learning when to let the ball reach the glass." },
      { level: 4, text: "You can keep a rally going at a comfortable pace, return simple rebounds and move forward with your partner. Fast balls still rush you." },
      { level: 5, text: "You use lobs and volleys with a clear purpose. You can defend familiar glass rebounds and usually cover your side with your partner." },
      { level: 6, text: "You change the height and direction of shots to create space. You can return many difficult rebounds, although pressure still causes rushed choices." },
      { level: 7, text: "You keep useful depth on your shots and move smoothly between defence and attack. Your overhead shots often help your pair hold the net." },
      { level: 8, text: "You manage quick exchanges and awkward rebounds with control. You adjust your position and shot selection to how the opposing pair plays." },
      { level: 9, text: "You build openings against very strong opponents through patient defence, precise placement and well-timed attacks. Your pair stays coordinated under sustained pressure." },
      { level: 10, text: "Against elite opponents, you repeatedly create or deny openings with very little time to react. Your shot quality and decisions hold up throughout demanding matches." },
    ],
  },
  tennis: {
    intro: "A groundstroke is a forehand or backhand played after the bounce. A volley is played before the bounce. Choose your level using the singles or doubles format you usually play, and mention that format when arranging a game.",
    levels: [
      { level: 1, text: "You are starting tennis and learning to send the ball towards a partner. You need help with serving and keeping score." },
      { level: 2, text: "You return easy balls when you have time to prepare. Starting a point with a serve and continuing the rally are still difficult." },
      { level: 3, text: "You can exchange several gentle groundstrokes and play points with the correct score. Your serve gets some points started, but rallies break down when you have to move." },
      { level: 4, text: "You can rally at a comfortable pace using both forehand and backhand. You usually start points with a legal serve and recover towards a useful position." },
      { level: 5, text: "You can aim groundstrokes towards open space and return moderate serves. You can play a simple volley, although depth and second serves vary." },
      { level: 6, text: "You use depth, direction and some spin to build a point. Your second serve is dependable at your usual pace, but faster opponents can disrupt your game." },
      { level: 7, text: "You can defend while moving and attack shorter balls with control. You use serve placement and changes of direction to set up your next shot." },
      { level: 8, text: "You handle pace and spin while keeping purposeful depth. You adjust patterns during a match and choose well when to defend, attack or approach the net." },
      { level: 9, text: "Against very strong opponents, you combine accurate serving, effective returns and sustained rally quality. You can change a failing plan under pressure." },
      { level: 10, text: "Against elite opponents, you maintain demanding serve, return and rally patterns with very little preparation time. You repeatedly turn small openings into an advantage." },
    ],
  },
  football: {
    intro: "Use these descriptions for your usual small-sided game. Goalkeepers should assess their contribution in goal, including positioning, handling, distribution and communication. A dedicated goalkeeper guide can be added when that role is supported.",
    levels: [
      { level: 1, text: "You are learning to control the ball and understand the flow of a game. You need guidance on positioning and the basic rules." },
      { level: 2, text: "You can make short passes and move with the ball when there is space. Receiving a moving ball and finding your position are still difficult." },
      { level: 3, text: "You can join a casual game, control simple passes and pass to a nearby teammate. You are learning to move into space after releasing the ball." },
      { level: 4, text: "You usually control and pass the ball at a relaxed game pace. You offer passing options and follow your opponent when your team loses possession." },
      { level: 5, text: "You look around before receiving and make useful choices between passing, carrying and shooting. You can keep the ball under moderate pressure." },
      { level: 6, text: "You receive and move the ball effectively in tighter spaces. You recognise when to support an attack, cover a teammate or recover into defence." },
      { level: 7, text: "You keep good control at a fast game pace and make decisions early. Your movement and defensive positioning help teammates play effectively." },
      { level: 8, text: "You handle close pressure and combine quickly with teammates. You adjust your role and timing to create space or stop an opponent’s attack." },
      { level: 9, text: "Against very strong players, you consistently influence possession and chances through technique, anticipation and movement. You stay effective when space and time are limited." },
      { level: 10, text: "Against elite players, you execute demanding actions at speed and read the next phase early. Your decisions and movement repeatedly create a meaningful team advantage." },
    ],
  },
  basketball: {
    intro: "Assess your contribution in the format you usually play, such as 3-on-3 or 5-on-5. Consider the skills needed for your role, along with passing, movement and defence.",
    levels: [
      { level: 1, text: "You are learning to dribble, pass and shoot. You need help with the rules and where to stand." },
      { level: 2, text: "You can dribble in open space, pass to a nearby teammate and attempt close shots. Controlling the ball while moving is still difficult." },
      { level: 3, text: "You can take part in a casual game and use basic dribbles and passes. You are learning to stay with your opponent and move away from crowded areas." },
      { level: 4, text: "You usually keep control at a relaxed game pace and make simple passes on time. You can attempt layups and recognise basic defensive responsibilities." },
      { level: 5, text: "You use space, cuts and passes to help your team create shots. You can protect the ball under moderate pressure and contribute on defence." },
      { level: 6, text: "You make useful decisions as defenders close in. You recognise screens, help on defence and recover, with reliable finishing or shooting for your role." },
      { level: 7, text: "You execute your role at a fast game pace. You read defensive help, create or finish good opportunities and communicate clearly on defence." },
      { level: 8, text: "You adapt to different defensive coverages and punish open space. Your decisions, positioning and skills stay effective under strong pressure." },
      { level: 9, text: "Against very strong players, you consistently create value in your role through efficient decisions and reliable execution. You read and adjust to repeated tactical changes." },
      { level: 10, text: "Against elite players, you execute complex actions with very little time and space. Your decisions and play within your role repeatedly improve your team’s chances." },
    ],
  },
  volleyball: {
    intro: "These descriptions refer to indoor volleyball. At higher levels, assess the skills required for your position. For example, a libero can be highly advanced through reception and defence. A beach volleyball guide should be separate.",
    levels: [
      { level: 1, text: "You are learning how to contact the ball and follow the scoring. You need guidance on court positions and rotation." },
      { level: 2, text: "You can send some serves over the net and return easy balls. Directing a first contact towards a teammate is still difficult." },
      { level: 3, text: "You can join a casual game, follow a simple rotation and keep some easy balls in play. Your passing and setting are becoming more controlled." },
      { level: 4, text: "You can serve reliably at a comfortable pace and pass easy balls towards the setter. You try to build rallies using separate pass, set and attack contacts." },
      { level: 5, text: "You can contribute to organised rallies and communicate who takes the ball. You understand basic coverage and can perform your role against moderate serves and attacks." },
      { level: 6, text: "You make useful contacts from less comfortable positions. You understand your rotation duties and help your team move from defending to attacking." },
      { level: 7, text: "You perform your position reliably at a fast game pace. You read opponents earlier and coordinate with teammates on reception, defence or the attack." },
      { level: 8, text: "You adjust your timing and positioning to different opponents and systems. Your key role skills remain controlled against powerful serves and attacks." },
      { level: 9, text: "Against very strong teams, you consistently support effective attacks or disrupt the opposition in your role. You adapt quickly when the planned play breaks down." },
      { level: 10, text: "Against elite teams, you execute your specialist role with precision at match speed. You read patterns early and make effective adjustments throughout demanding rallies." },
    ],
  },
  squash: {
    intro: "A drive is a shot hit straight down the side wall. A boast comes off a side wall first. Choose your level using the singles game you usually play.",
    levels: [
      { level: 1, text: "You are starting squash and learning to hit the ball to the front wall. You need help with serving, scoring and the lines." },
      { level: 2, text: "You can serve into the correct box and return easy balls that come straight to you. Rallies end quickly because you are still learning to get to the ball." },
      { level: 3, text: "You can keep a gentle rally going and follow the score. You are learning to return to the middle of the court after your shot." },
      { level: 4, text: "You can hit straight drives at a comfortable pace and return simple boasts. You usually get back to the middle between shots." },
      { level: 5, text: "You use length and width on purpose to move your opponent. You can volley easy balls and play a basic drop when balanced." },
      { level: 6, text: "You build points with drives, boasts and drops. You defend reasonably from the back corners, although pressure still rushes your choices." },
      { level: 7, text: "You keep good length under pace and take the ball early when you can. You read the boast and the drop before they happen." },
      { level: 8, text: "You control the middle of the court in fast rallies and change the pace and height to your advantage. You adjust your plan during a match." },
      { level: 9, text: "Against very strong opponents, you combine tight length, deception and quick recovery. You turn defensive situations into attacking ones." },
      { level: 10, text: "Against elite opponents, you keep accuracy and pace through long rallies with very little time to react. You repeatedly exploit small openings." },
    ],
  },
  badminton: {
    intro: "A clear sends the shuttle deep towards the back of the court. A drop sends it towards the front. Assess your usual singles or doubles format and mention the format when finding a game.",
    levels: [
      { level: 1, text: "You are starting badminton and learning to contact the shuttle. You need help with serving, scoring and court boundaries." },
      { level: 2, text: "You can serve some shuttles into the correct area and return easy shots. Exchanges are short because your timing and movement are still developing." },
      { level: 3, text: "You can keep a gentle rally going and follow the score. You are learning to reach shots away from your starting position." },
      { level: 4, text: "You can use simple clears, lifts and net shots at a comfortable pace. You recover towards a useful position after most shots." },
      { level: 5, text: "You move an opponent between the front and back of the court. You can use a drop or smash when balanced, although depth and recovery vary." },
      { level: 6, text: "You link shots into a plan and recover effectively after moving. You can defend moderate attacks and choose when to lift or keep the shuttle low." },
      { level: 7, text: "You manage fast rallies with controlled placement and early preparation. You choose attacking or defensive positions that fit singles or doubles." },
      { level: 8, text: "You handle sustained pressure and vary speed, direction and disguise. You read opponents early and change your plan during a game." },
      { level: 9, text: "Against very strong opponents, you consistently build openings through precise placement and quick recovery. You can turn difficult defensive situations into effective replies." },
      { level: 10, text: "Against elite opponents, you maintain shot quality and tactical control at very high rally speeds. You anticipate patterns and exploit small openings with precision." },
    ],
  },
};
export const GUIDED_SPORTS = Object.keys(GUIDE);
