// The built-in playground examples the founder approved (ADR-434 (c), mockup.html).
//
// Inputs only. The mockup carried recorded probabilities beside each one so it could demo
// without an engine; here the numbers must come from the model that is actually loaded, which
// need not be the one those were measured on.

export type CheckExample = {
  id: string
  label: string
  premise: string
  hypotheses: string[]
}

export type ChooseExample = {
  id: string
  label: string
  question: string
  options: string[]
}

export const JEV_EXAMPLES: { check: CheckExample[]; choose: ChooseExample[] } = {
  check: [
    {
      id: 'kitchen',
      label: 'Example: kitchen (check)',
      premise: 'A chef is chopping onions in a busy restaurant kitchen.',
      hypotheses: [
        'Someone is preparing food.',
        'The kitchen is empty and silent.',
        'The chef is wearing a blue apron.',
      ],
    },
    {
      id: 'stage',
      label: 'Example: stage (check)',
      premise: 'A man is playing a guitar on stage.',
      hypotheses: [
        'A man is performing music.',
        'The man is asleep in bed.',
        'The man is wearing a red hat.',
      ],
    },
  ],
  choose: [
    {
      id: 'capital',
      label: 'Example: capital (choose)',
      question: 'What is the capital of France?',
      options: ['Berlin', 'Paris', 'Madrid'],
    },
    {
      id: 'plants',
      label: 'Example: plants (choose)',
      question: 'Which gas do plants absorb during photosynthesis?',
      options: ['oxygen', 'carbon dioxide', 'nitrogen'],
    },
  ],
}
