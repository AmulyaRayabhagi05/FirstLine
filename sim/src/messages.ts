// Free-text SOS messages, written the way people actually type in a crisis.
import type { Language } from "./types.js";

export type SosReason =
  | "hypothermia_self"
  | "hypothermia_relative"
  | "oxygen"
  | "dialysis"
  | "co"
  | "fall"
  | "supplies"
  | "pipes"
  | "ride"
  | "worried";

type Templates = Record<SosReason, Partial<Record<Language, string[]>>>;

const T: Templates = {
  hypothermia_self: {
    en: ["power out since last night, its freezing in here and I cant get warm. I'm 81 and alone", "no heat, house is so cold, I cant feel my hands. please send someone", "help please no power no heat i am old and cannot get to the car"],
    es: ["No hay luz ni calefacción, tengo mucho frío y vivo sola. Ayúdenme por favor", "hace demasiado frío en la casa, no puedo calentarme, tengo 79 años", "sin luz desde hace horas, estoy temblando, por favor ayuda"],
    vi: ["mất điện, nhà rất lạnh, tôi già và ở một mình, xin giúp đỡ", "không có sưởi, tôi lạnh quá không chịu được"],
  },
  hypothermia_relative: {
    en: ["my dad cant walk and the house is freezing, power has been out for hours, we need help moving him somewhere warm", "my grandmother is shaking and confused, no heat, she uses a wheelchair"],
    es: ["Se fue la luz y hace mucho frío. Mi mamá no puede caminar y no tenemos calefacción. Por favor ayuda", "mi abuelo está temblando y no responde bien, no tenemos luz, necesitamos ayuda para moverlo"],
    vi: ["mẹ tôi không đi được, nhà lạnh quá, mất điện, cần giúp đưa bà đi chỗ ấm"],
  },
  oxygen: {
    en: ["my oxygen machine stopped when the power went out, backup tank almost empty", "oxygen concentrator not working no power, having trouble breathing"],
    es: ["Mi máquina de oxígeno se apagó con el apagón y el tanque ya casi se acaba", "mi esposo usa oxígeno y no hay luz, le cuesta respirar"],
    vi: ["máy oxy của tôi tắt vì mất điện, bình dự phòng sắp hết"],
  },
  dialysis: {
    en: ["I do home dialysis at night and the machine is dead, I need to get to a center", "missed my dialysis, no power for the machine, roads are ice"],
    es: ["hago diálisis en casa y la máquina no prende sin luz, necesito ir a un centro"],
  },
  co: {
    en: ["we were running the car in the garage to stay warm and now my wife wont wake up and I have a headache", "kids are throwing up and dizzy, we have the grill inside for heat"],
    es: ["prendimos el carro en la cochera para calentarnos y mi hijo no despierta, nos duele la cabeza", "usamos la parrilla adentro y todos estamos mareados"],
  },
  fall: {
    en: ["I fell in the dark and cant get up, I think my hip is hurt", "slipped on the ice by the door, cant stand, freezing out here"],
    es: ["me caí en la oscuridad y no me puedo levantar", "me resbalé en el hielo y no puedo pararme"],
    vi: ["tôi bị ngã trong bóng tối, không đứng dậy được"],
  },
  supplies: {
    en: ["out of water, pipes frozen, have 2 little kids", "need blankets and water, no power, baby at home", "anyone have a generator? need to keep insulin cold"],
    es: ["no tenemos agua, se congelaron las tuberías, tengo niños chiquitos", "necesitamos cobijas y agua, no hay luz"],
    vi: ["hết nước, ống nước đóng băng, có con nhỏ"],
  },
  pipes: {
    en: ["pipe burst in the ceiling, water everywhere, no power", "water pouring in from burst pipe, cant find the shutoff"],
    es: ["se reventó una tubería y hay agua por todos lados"],
  },
  ride: {
    en: ["need a ride to the warming center, my car wont start", "can someone take us to a shelter, house is too cold for the kids"],
    es: ["necesitamos que alguien nos lleve al refugio, hace mucho frío para los niños"],
    vi: ["cần người chở đến trung tâm sưởi ấm"],
  },
  worried: {
    en: ["cant reach my mom on Lakewood Blvd, her phone is dead, can someone check on her", "neighbor across the street hasnt come out, lights off, worried"],
    es: ["no puedo comunicarme con mi tía, su teléfono está apagado, alguien puede ir a verla"],
  },
};

export function sosMessage(reason: SosReason, lang: Language, u: number): string {
  const pool = T[reason][lang] ?? T[reason].es ?? T[reason].en!;
  // Spanish-dominant mix: if there is no template in this language fall back to English.
  const list = pool.length ? pool : T[reason].en!;
  return list[Math.floor(u * list.length) % list.length];
}

export const CHECKIN_NOTES: Record<Language, string[]> = {
  en: ["we're ok, cold but fine", "safe, at my sister's", "ok for now", "fine, have a fireplace"],
  es: ["estamos bien", "bien, con frío pero bien", "estamos en casa de mi hermana"],
  vi: ["chúng tôi ổn", "ổn, hơi lạnh"],
};
