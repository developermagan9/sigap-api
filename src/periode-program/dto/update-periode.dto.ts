import { PartialType } from '@nestjs/swagger';
import { CreatePeriodeDto } from './create-periode.dto';

export class UpdatePeriodeDto extends PartialType(CreatePeriodeDto) {}
